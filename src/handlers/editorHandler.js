const db = require('../db/supabase');
const { sendMessage, sendToOwners, sendFileToOwners } = require('../services/telegram');
const fmt = require('../services/formatters');
const kb = require('../services/keyboards');
const assignments = require('../services/assignments');
const { pendingBlockReason } = require('./pendingState');
const config = require('../config');

// Attach the clients join when resolving via assignment msg id or task list
// so taskTitle() works correctly in notifications.

async function handleEditorMessage(editor, body, quotedMsgId) {
  const text = body.trim().toLowerCase();

  // ── awaiting a block reason (editor tapped the 🚫 Blocked button) ───────────
  // Capture the next free-text message as the reason — unless they typed another
  // recognised command instead, in which case drop the wait and handle that.
  if (pendingBlockReason.has(editor.telegram_id)) {
    if (isKnownEditorCommand(body)) {
      pendingBlockReason.delete(editor.telegram_id);
    } else {
      const { taskId, title } = pendingBlockReason.get(editor.telegram_id);
      pendingBlockReason.delete(editor.telegram_id);
      await applyBlockReason(editor, taskId, title, body.trim());
      return;
    }
  }

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

  // ── availability (self-service on-leave) ────────────────────────────────────
  if (['unavailable', 'leave', 'on leave', 'off'].includes(text)) {
    await setSelfAvailability(editor, false);
    return;
  }
  if (['available', 'back', 'im back', "i'm back"].includes(text)) {
    await setSelfAvailability(editor, true);
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

// True when the text is a recognised editor command (so it shouldn't be swallowed
// as a pending block reason). Status commands count as commands.
function isKnownEditorCommand(body) {
  const t = body.trim().toLowerCase();
  if (['help', 'my tasks', 'send raw folder', 'send final folder'].includes(t)) return true;
  if (['unavailable', 'leave', 'on leave', 'off', 'available', 'back', 'im back', "i'm back"].includes(t)) return true;
  return parseStatusCommand(body) != null;
}

// Editor toggles their own availability. On-leave editors keep their current
// tasks but are skipped by the load balancer for NEW work. Owners are notified.
async function setSelfAvailability(editor, available) {
  try {
    await db.setEditorAvailable(editor.id, available);
  } catch (err) {
    console.warn('[Editor] availability update failed:', err.message);
    await sendMessage(editor.telegram_id, `⚠️ Couldn't update your availability right now. Please tell management.`);
    return;
  }
  await sendMessage(
    editor.telegram_id,
    available
      ? `✅ You're marked *available* — new work can come your way again.`
      : `🌴 You're marked *on leave*. You won't get new assignments until you send *available*. Your current tasks stay with you.`
  );
  await sendToOwners(`🌴 *${editor.name}* marked themselves *${available ? 'available' : 'on leave'}*.`);
}

// Records the reason an editor gave after tapping the Blocked button and relays
// it to the owners. The task is already in the blocked state at this point.
async function applyBlockReason(editor, taskId, title, reason) {
  try {
    await db.updateTaskStatus(taskId, 'blocked', { blocked_reason: reason });
  } catch (err) {
    console.warn('[Editor] Could not store block reason:', err.message);
  }
  await sendToOwners(
    `🚫 *Block Reason — ${title}*\n\n` +
    `Employee: *${editor.name}*\n` +
    `Reason: _${reason}_`
  );
  await sendMessage(editor.telegram_id, `✅ Thanks — I've passed your reason on to the owners.`);
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

  if (status === 'in_progress') {
    await db.updateTaskStatus(task.id, status);
    await sendMessage(editor.telegram_id, `✅ Got it! *${fmt.taskTitle(task)}* marked as In Progress.`);
    return;
  }

  if (status === 'completed') {
    // Approval flow: "done" submits the work for owner review, it isn't completed yet.
    if (task.status === 'submitted_for_review') {
      await sendMessage(
        editor.telegram_id,
        `📤 *${fmt.taskTitle(task)}* is already submitted and waiting for owner approval.`
      );
      return;
    }
    await submitForReviewFlow(editor, task, { hasFile: false });
    await sendMessage(
      editor.telegram_id,
      `📤 Submitted *${fmt.taskTitle(task)}* for owner review. You'll be notified once it's approved or if changes are requested.`
    );
    return;
  }
}

// Moves a task into the owner-review state and alerts the owners with Approve /
// Request Changes buttons. When `hasFile` is true the deliverable file was just
// forwarded to the owners carrying those buttons itself, so we skip the text ping
// to avoid a duplicate. Shared by the "done" text command and file-with-"done".
async function submitForReviewFlow(editor, task, { hasFile }) {
  await assignments.submitForReview(task);
  if (hasFile) return;
  await assignments.notifyOwnersOfSubmission(editor, task);
}

// ── File / deliverable uploads ──────────────────────────────────────────────
// Any file an editor sends is forwarded to the owners. When the file is a reply
// to an assignment message (or its caption names a task), it's linked to that
// task and recorded as the deliverable. A caption of "done" both submits the
// file and marks the task completed in one step.
async function handleEditorFile(editor, file, quotedMsgId) {
  const { fileId, fileType, fileName, caption } = file;

  // A caption of "done"/"completed" (optionally "done 2") means: submit AND finish.
  const cmd = parseStatusCommand(caption || '');
  const wantsComplete = !!cmd && cmd.status === 'completed';
  const captionTaskNumber = cmd ? cmd.taskNumber : null;
  // Treat the caption as a free-text note only when it isn't a status command.
  const note = cmd ? null : (caption || '').trim();

  // Link the file to a task: quoted assignment msg → number in caption → sole task.
  const resolved = await resolveTargetTask(editor, quotedMsgId, captionTaskNumber);
  const task = resolved.task || null;                       // present on success or already_done
  const linkable = !!task && resolved.error !== 'already_done';
  const title = task ? fmt.taskTitle(task) : null;

  // 1) Always forward the file to the owners — the core requirement. When the
  //    file is linked to a task, attach Approve / Request Changes buttons so an
  //    owner can act on the deliverable straight from the file message.
  let ownerCaption = `📎 *File from ${editor.name}*`;
  if (title) ownerCaption += `\n📋 Task: *${title}*`;
  if (note) ownerCaption += `\n📝 _${note}_`;
  if (wantsComplete && linkable) ownerCaption += `\n📤 *Submitted for review* by employee.`;
  const replyMarkup = linkable ? kb.ownerReviewButtons(task.id) : undefined;
  const forwarded = await sendFileToOwners({ fileId, fileType, caption: ownerCaption, replyMarkup });

  // 2) Record it as the task's deliverable + the per-owner message ids, so an
  //    owner can reply to the file to request changes (best-effort — cols may be new).
  if (linkable) {
    try {
      await db.setTaskDeliverable(task.id, { fileId, fileType, fileName });
      task.deliverable_file_id = fileId; // so the submission notice mentions it
      const ownerMsgs = {};
      for (const f of forwarded) if (f.messageId != null) ownerMsgs[f.ownerId] = f.messageId;
      if (Object.keys(ownerMsgs).length) await db.setTaskDeliverableOwnerMsgs(task.id, ownerMsgs);
    } catch (err) {
      console.warn('[Editor] Could not store deliverable:', err.message);
    }
  }

  // 3) If the caption said "done", submit the task for owner review.
  if (wantsComplete && linkable) {
    await submitForReviewFlow(editor, task, { hasFile: true });
    await sendMessage(
      editor.telegram_id,
      `📤 Got your file and forwarded it to the owners — *${title}* is now *Submitted for Review*. You'll hear back once it's approved or if changes are needed.`
    );
    return;
  }

  // 4) Otherwise acknowledge the upload.
  if (linkable) {
    await sendMessage(
      editor.telegram_id,
      `📎 Got your file for *${title}* and forwarded it to the owners.\n` +
      `↩️ Reply *done* to that task's message when it's finished.`
    );
    return;
  }
  if (task && resolved.error === 'already_done') {
    await sendMessage(
      editor.telegram_id,
      `📎 Forwarded your file to the owners.\nℹ️ *${title}* is already completed.`
    );
    return;
  }
  // No task context — still forwarded, just not linked.
  let msg = `📎 Forwarded your file to the owners.`;
  if (resolved.error === 'ambiguous') {
    msg += `\n💡 To attach it to a specific task, *reply to that task's assignment message* with the file.`;
  } else if (resolved.error === 'none') {
    msg += `\nℹ️ You have no active tasks right now, so I couldn't link it to one.`;
  } else {
    msg += `\n💡 Tip: reply to a task's assignment message with the file so I can link it.`;
  }
  await sendMessage(editor.telegram_id, msg);
}

module.exports = { handleEditorMessage, handleEditorFile };
