const db = require('../db/supabase');
const { sendMessage, sendToOwners } = require('../services/telegram');
const fmt = require('../services/formatters');
const config = require('../config');

// Attach the clients join when resolving via assignment msg id or task list
// so taskTitle() works correctly in notifications.

async function handleEditorMessage(editor, body, quotedMsgId) {
  const text = body.trim().toLowerCase();

  // ── help ──────────────────────────────────────────────────────────────────
  if (text === 'help') {
    await sendMessage(editor.telegram_id, fmt.helpMenu(false));
    return;
  }

  // ── my tasks ──────────────────────────────────────────────────────────────
  if (text === 'my tasks') {
    const tasks = await db.getTasksForEditorWithJoin(editor.id);
    await sendMessage(editor.telegram_id, fmt.editorTaskList(tasks));
    return;
  }

  // ── drive links ───────────────────────────────────────────────────────────
  if (text === 'send raw folder') {
    await sendMessage(editor.telegram_id, `📁 *Raw Files Folder:*\n${config.drive.rawFiles}`);
    return;
  }
  if (text === 'send final folder') {
    await sendMessage(editor.telegram_id, `📁 *Final Data Folder:*\n${config.drive.finalData}`);
    return;
  }

  // ── status updates ────────────────────────────────────────────────────────
  // Supports: "started", "done", "blocked [reason]" — optionally with a task
  // number ("done 2") or by quote-replying the original assignment message.
  const cmd = parseStatusCommand(body);
  if (cmd) {
    await handleStatusUpdate(editor, cmd, quotedMsgId);
    return;
  }

  // ── unrecognised ──────────────────────────────────────────────────────────
  await sendMessage(
    editor.telegram_id,
    `❓ I didn't understand that. Type *help* to see available commands.`
  );
}

// Parses an editor status command into { status, taskNumber, reason }.
// Returns null if the text isn't a status command.
// Examples: "done", "done 2", "started 1", "blocked", "blocked 2 waiting on assets".
function parseStatusCommand(body) {
  const text = body.trim();
  let m;

  if ((m = text.match(/^(done|completed|complete|finished)\b\s*(\d+)?/i))) {
    return { status: 'completed', taskNumber: m[2] ? parseInt(m[2], 10) : null };
  }
  if ((m = text.match(/^(started|start|in[\s-]?progress|wip|ongoing)\b\s*(\d+)?/i))) {
    return { status: 'in_progress', taskNumber: m[2] ? parseInt(m[2], 10) : null };
  }
  if (/^blocked\b/i.test(text)) {
    let rest = text.replace(/^blocked\s*/i, '');
    let taskNumber = null;
    const numMatch = rest.match(/^(\d+)\s*/);
    if (numMatch) {
      taskNumber = parseInt(numMatch[1], 10);
      rest = rest.slice(numMatch[0].length);
    }
    const reason = rest.replace(/^[\s\-–—:]+/, '').trim() || 'No reason given';
    return { status: 'blocked', taskNumber, reason };
  }
  return null;
}

// Figures out WHICH task an update applies to.
// Priority: 1) quoted assignment message  2) explicit task number  3) sole active task.
// Returns { task } on success, or { error, tasks } when it can't decide.
async function resolveTargetTask(editor, quotedMsgId, taskNumber) {
  // 1) Quote-reply to the original assignment message — most precise.
  if (quotedMsgId) {
    let quotedTask = null;
    try {
      quotedTask = await db.getTaskByAssignmentMsgId(quotedMsgId);
    } catch (err) {
      // e.g. assignment_msg_id column not migrated yet — degrade gracefully.
      console.warn('[Editor] Quoted-task lookup failed:', err.message);
    }
    if (quotedTask) {
      if (quotedTask.assigned_to !== editor.id) return { error: 'not_yours' };
      if (quotedTask.status === 'completed') return { error: 'already_done', task: quotedTask };
      return { task: quotedTask };
    }
    // Quoted some other message — fall through to the remaining methods.
  }

  // The numbered list shown to the editor (ordered by deadline) — used for "done 2".
  const tasks = await db.getTasksForEditorWithJoin(editor.id);

  if (taskNumber != null) {
    if (taskNumber >= 1 && taskNumber <= tasks.length) return { task: tasks[taskNumber - 1] };
    return { error: 'bad_number', tasks };
  }

  if (tasks.length === 0) return { error: 'none' };
  if (tasks.length === 1) return { task: tasks[0] };
  return { error: 'ambiguous', tasks };
}

async function handleStatusUpdate(editor, cmd, quotedMsgId) {
  const { status, taskNumber, reason } = cmd;
  const result = await resolveTargetTask(editor, quotedMsgId, taskNumber);

  // ── Could not resolve a single task — guide the editor ────────────────────
  if (result.error) {
    if (result.error === 'none') {
      await sendMessage(editor.telegram_id, `✅ You have no active tasks to update.`);
    } else if (result.error === 'not_yours') {
      await sendMessage(editor.telegram_id, `❌ That task isn't assigned to you.`);
    } else if (result.error === 'already_done') {
      await sendMessage(editor.telegram_id, `✅ *${result.task.project_name}* is already completed.`);
    } else if (result.error === 'bad_number') {
      await sendMessage(
        editor.telegram_id,
        `❌ There's no task #${taskNumber}.\n\n${fmt.editorTaskList(result.tasks)}`
      );
    } else if (result.error === 'ambiguous') {
      await sendMessage(
        editor.telegram_id,
        `🤔 You have *${result.tasks.length}* active tasks, so I'm not sure which one you mean.\n\n` +
        `${fmt.editorTaskList(result.tasks)}\n\n` +
        `👉 *Reply to the specific project's message* (swipe/long-press → Reply), or add its number — e.g. *${reason != null ? 'blocked 2 reason' : status === 'completed' ? 'done 2' : 'started 2'}*.`
      );
    }
    return;
  }

  const task = result.task;

  if (status === 'blocked') {
    await db.updateTaskStatus(task.id, 'blocked', { blocked_reason: reason });
    const title = fmt.taskTitle(task);
    await sendMessage(
      editor.telegram_id,
      `🚫 *${title}* has been marked as Blocked.\nI've alerted the owners.`
    );
    await sendToOwners(
      `🚫 *Task Blocked — Action Required!*\n\n` +
      `Employee: *${editor.name}*\n` +
      `Task: *${title}*\n` +
      `Type: ${fmt.fmtType(task.type)}\n` +
      `Deadline: ${fmt.fmtDeadline(task.deadline)}\n\n` +
      `Reason: _${reason}_`
    );
    return;
  }

  await db.updateTaskStatus(task.id, status);
  const title = fmt.taskTitle(task);

  if (status === 'in_progress') {
    await sendMessage(editor.telegram_id, `✅ Got it! *${title}* marked as In Progress.`);
  } else if (status === 'completed') {
    await sendMessage(editor.telegram_id, `🎉 Great work! *${title}* marked as Completed.`);
    await sendToOwners(
      `✅ *Task Completed!*\n\n` +
      `Employee: *${editor.name}*\n` +
      `Task: *${title}*\n` +
      `Type: ${fmt.fmtType(task.type)}\n` +
      `Deadline was: ${fmt.fmtDeadline(task.deadline)}`
    );
  }
}

module.exports = { handleEditorMessage };
