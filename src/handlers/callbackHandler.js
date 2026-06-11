// Handles every inline-button tap (Telegram callback_query). Routes the short
// callback-data verb (see services/keyboards.js) to the right action, mirroring
// the text-command flows so buttons and typing stay interchangeable.

const db = require('../db/supabase');
const config = require('../config');
const fmt = require('../services/formatters');
const kb = require('../services/keyboards');
const assignments = require('../services/assignments');
const {
  answerCallback, editMessageReplyMarkup, sendMessage, sendToOwners,
} = require('../services/telegram');
const { pendingAssignments, pendingBlockReason, pendingChangeNotes } = require('./pendingState');

async function handleCallbackQuery(query) {
  const from = String(query.from?.id ?? '');
  const chatId = String(query.message?.chat?.id ?? from);
  const messageId = query.message?.message_id;

  const parsed = kb.parseCallbackData(query.data);
  if (!parsed) { await answerCallback(query.id); return; }
  const { action, id } = parsed;
  const ctx = { query, from, chatId, messageId };

  switch (action) {
    case kb.ACTIONS.STARTED:
    case kb.ACTIONS.DONE:
    case kb.ACTIONS.BLOCKED:
      return handleEditorAction(ctx, action, id);
    case kb.ACTIONS.APPROVE:
    case kb.ACTIONS.CHANGES:
      return handleOwnerReviewAction(ctx, action, id);
    case kb.ACTIONS.PICK_EDITOR:
      return handlePickEditor(ctx, id);
    default:
      await answerCallback(query.id);
  }
}

// ── Editor task buttons: Started / Done / Blocked ────────────────────────────────
async function handleEditorAction({ query, from, chatId, messageId }, action, taskId) {
  const editor = await db.getEditorByTelegramId(from);
  if (!editor) { await answerCallback(query.id, 'You are not registered in the system.', true); return; }

  const task = await db.getTaskById(taskId);
  if (!task) { await answerCallback(query.id, 'That task no longer exists.', true); return; }
  if (task.assigned_to !== editor.id) { await answerCallback(query.id, "That task isn't assigned to you.", true); return; }

  const title = fmt.taskTitle(task);

  if (task.status === 'completed') {
    await answerCallback(query.id, 'That task is already completed.');
    return;
  }

  if (action === kb.ACTIONS.STARTED) {
    await db.updateTaskStatus(task.id, 'in_progress');
    await answerCallback(query.id, '🔄 Marked In Progress');
    await sendMessage(chatId, `✅ Got it! *${title}* marked as In Progress.`);
    return;
  }

  if (action === kb.ACTIONS.DONE) {
    if (task.status === 'submitted_for_review') {
      await answerCallback(query.id, 'Already submitted — waiting for owner approval.');
      return;
    }
    await assignments.submitForReview(task);
    await assignments.notifyOwnersOfSubmission(editor, task);
    await editMessageReplyMarkup(chatId, messageId, null); // consume the buttons
    await answerCallback(query.id, '📤 Submitted for review');
    await sendMessage(
      chatId,
      `📤 Submitted *${title}* for owner review. You'll be notified once it's approved or if changes are requested.`
    );
    return;
  }

  if (action === kb.ACTIONS.BLOCKED) {
    await db.updateTaskStatus(task.id, 'blocked', { blocked_reason: null });
    pendingBlockReason.set(from, { taskId: task.id, title });
    await answerCallback(query.id, '🚫 Marked Blocked — send me the reason');
    // Alert owners now (reason follows once the employee types it).
    await sendToOwners(
      `🚫 *Task Blocked — Action Required!*\n\n` +
      `Employee: *${editor.name}*\n` +
      `Task: *${title}*\n` +
      `Type: ${fmt.fmtType(task.type)}\n` +
      `Deadline: ${fmt.fmtDeadline(task.deadline)}\n\n` +
      `Reason: _awaiting from employee…_`
    );
    await sendMessage(
      chatId,
      `🚫 *${title}* marked as Blocked. Please reply with the *reason* so I can pass it to the owners.`
    );
    return;
  }
}

// ── Owner review buttons: Approve / Request Changes ──────────────────────────────
async function handleOwnerReviewAction({ query, from, chatId, messageId }, action, taskId) {
  if (!config.isOwner(from)) { await answerCallback(query.id, 'Only owners can do that.', true); return; }

  const task = await db.getTaskById(taskId);
  if (!task) { await answerCallback(query.id, 'That task no longer exists.', true); return; }

  if (action === kb.ACTIONS.APPROVE) {
    if (task.status === 'completed') {
      await answerCallback(query.id, 'Already approved.');
      await editMessageReplyMarkup(chatId, messageId, null);
      return;
    }
    await assignments.approveTask(task, 'Telegram (button)');
    await editMessageReplyMarkup(chatId, messageId, null);
    await answerCallback(query.id, '✅ Approved');
    return;
  }

  if (action === kb.ACTIONS.CHANGES) {
    // Capture the owner's next message as the change notes (see ownerHandler).
    // `attachments` collects any reference files the owner sends before the notes.
    const title = fmt.taskTitle(task);
    pendingChangeNotes.set(from, { taskId: task.id, title, attachments: [] });
    await answerCallback(query.id, '🔁 Send the change notes');
    await sendMessage(
      chatId,
      `🔁 *Request Changes — ${title}*\n\n` +
      `Reply with *what needs to change* and I'll send it to ${task.editors?.name || 'the employee'}.\n\n` +
      `📎 _Optional:_ send reference *files, videos, or a folder link* first — they'll go along with your notes.`
    );
    return;
  }
}

// ── Assignment confirmation buttons: pick an employee ────────────────────────────
async function handlePickEditor({ query, from, chatId, messageId }, editorId) {
  if (!config.isOwner(from)) { await answerCallback(query.id, 'Only owners can assign work.', true); return; }

  const pending = pendingAssignments.get(from);
  if (!pending) {
    await answerCallback(query.id, 'This assignment expired — start again with "new project:".', true);
    return;
  }
  const chosen = pending.ranked.find((s) => s.editor.id === editorId);
  if (!chosen) { await answerCallback(query.id, 'That employee is no longer available.', true); return; }

  await assignments.assignProject({
    projectName: pending.projectName,
    type: pending.type,
    editor: chosen.editor,
    deadline: pending.deadline,
    note: pending.note,
    priority: pending.priority,
    source: 'Telegram (button)',
    clientId: pending.clientId,
  });
  pendingAssignments.delete(from);
  await editMessageReplyMarkup(chatId, messageId, null);
  await answerCallback(query.id, `Assigned to ${chosen.editor.name}`);
}

module.exports = { handleCallbackQuery };
