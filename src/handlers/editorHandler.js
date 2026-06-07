const db = require('../db/supabase');
const { sendMessage, sendToOwners, sendFileToOwners } = require('../services/telegram');
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

  if (status === 'in_progress') {
    await db.updateTaskStatus(task.id, status);
    await sendMessage(editor.telegram_id, `✅ Got it! *${fmt.taskTitle(task)}* marked as In Progress.`);
    return;
  }

  if (status === 'completed') {
    await completeTask(editor, task);
    await sendMessage(editor.telegram_id, `🎉 Great work! *${fmt.taskTitle(task)}* marked as Completed.`);
    return;
  }
}

// Marks a task completed and notifies the owners. Mentions the deliverable file
// when one was submitted (it will already have been forwarded to the owners).
// Shared by the "done" text command and the file-with-"done"-caption flow.
async function completeTask(editor, task) {
  await db.updateTaskStatus(task.id, 'completed');
  const title = fmt.taskTitle(task);
  await sendToOwners(
    `✅ *Task Completed!*\n\n` +
    `Employee: *${editor.name}*\n` +
    `Task: *${title}*\n` +
    `Type: ${fmt.fmtType(task.type)}\n` +
    `Deadline was: ${fmt.fmtDeadline(task.deadline)}` +
    (task.deliverable_file_id ? `\n\n📎 Final file shared above.` : ``)
  );
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

  // 1) Always forward the file to the owners — the core requirement.
  let ownerCaption = `📎 *File from ${editor.name}*`;
  if (title) ownerCaption += `\n📋 Task: *${title}*`;
  if (note) ownerCaption += `\n📝 _${note}_`;
  if (wantsComplete && linkable) ownerCaption += `\n✅ Marked *Completed* by employee.`;
  const forwarded = await sendFileToOwners({ fileId, fileType, caption: ownerCaption });

  // 2) Record it as the task's deliverable + the per-owner message ids, so an
  //    owner can reply to the file to request changes (best-effort — cols may be new).
  if (linkable) {
    try {
      await db.setTaskDeliverable(task.id, { fileId, fileType, fileName });
      task.deliverable_file_id = fileId; // so completeTask() mentions it
      const ownerMsgs = {};
      for (const f of forwarded) if (f.messageId != null) ownerMsgs[f.ownerId] = f.messageId;
      if (Object.keys(ownerMsgs).length) await db.setTaskDeliverableOwnerMsgs(task.id, ownerMsgs);
    } catch (err) {
      console.warn('[Editor] Could not store deliverable:', err.message);
    }
  }

  // 3) If the caption said "done", complete the task too.
  if (wantsComplete && linkable) {
    await completeTask(editor, task);
    await sendMessage(
      editor.telegram_id,
      `🎉 Got your file and forwarded it to the owners — *${title}* is now marked *Completed*. Great work!`
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
