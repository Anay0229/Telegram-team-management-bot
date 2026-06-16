// Shared assignment logic used by BOTH the Telegram owner flow and the admin portal.

const db = require('../db/supabase');
const { sendMessage, sendToOwners, sendFile } = require('./telegram');
const fmt = require('./formatters');
const kb = require('./keyboards');
const config = require('../config');

function parseDeadline(dateStr) {
  if (!dateStr) return null;
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();

  const withYear = `${dateStr} ${new Date().getFullYear()}`;
  const parsed2 = new Date(withYear);
  if (!isNaN(parsed2.getTime())) {
    if (parsed2 < new Date()) parsed2.setFullYear(parsed2.getFullYear() + 1);
    return parsed2.toISOString();
  }
  return null;
}

// Editors always receive the Raw Files folder on assignment — that's their source
// material to work from (read from DRIVE_RAW_FILES in .env).
function driveLink() {
  return config.drive.rawFiles;
}

async function assignProject({ projectName, type, editor, deadline, note, source, clientId, priority }) {
  const client = clientId ? await db.getClientById(clientId) : null;
  const clientName = client?.name || null;
  const link = driveLink();

  const task = await db.createTask({
    projectName,
    type,
    assignedTo: editor.id,
    deadline,
    driveLink: link,
    note,
    clientId: clientId || null,
    priority: priority || 'normal',
  });

  // Preserve the original deadline for the work-record history (best-effort —
  // column may be new). The revision flow never touches initial_deadline.
  try {
    await db.markInitialDeadline(task.id, deadline);
  } catch (err) {
    console.warn('[Assign] Could not store initial deadline:', err.message);
  }

  const sent = await sendMessage(
    editor.telegram_id,
    fmt.assignmentNotification(clientName, projectName, type, deadline, link, note, task.priority || priority, task),
    kb.editorTaskButtons(task.id)
  );
  const msgId = sent?.message_id?.toString() || null;
  if (msgId) {
    try {
      await db.updateTaskAssignmentMsgId(task.id, msgId);
    } catch (err) {
      console.warn('[Assign] Could not store assignment message id:', err.message);
    }
  }

  await sendToOwners(
    `✅ *Work Assigned!*\n\n` +
    `🆔 Task: \`${fmt.taskCode(task)}\`\n` +
    (clientName ? `Client: *${clientName}*\n` : '') +
    `Work: *${projectName}*\n` +
    `Employee: *${editor.name}*\n` +
    `Type: ${fmt.fmtType(type)}\n` +
    (fmt.fmtPriority(task.priority || priority) ? `Priority: ${fmt.fmtPriority(task.priority || priority)}\n` : '') +
    `Deadline: ${fmt.fmtDeadline(deadline)}\n` +
    (note ? `Note: _${note}_\n` : '') +
    `Drive link sent to employee.` +
    (source ? `\n_(via ${source})_` : '')
  );

  return task;
}

async function changeTaskStatus(task, status, reason) {
  const extra =
    status === 'blocked' ? { blocked_reason: reason } :
    status === 'pending' ? { blocked_reason: null } :
    {};

  await db.updateTaskStatus(task.id, status, extra);

  const editorName = task.editors?.name || 'Unassigned';
  const title = fmt.taskTitle(task);

  await sendToOwners(
    `✏️ *Status Updated by Management*\n\n` +
    `Task: *${title}*\n` +
    `Employee: *${editorName}*\n` +
    `New status: ${fmt.fmtStatus(status)}` +
    (status === 'blocked' && reason ? `\nReason: _${reason}_` : '')
  );

  if (task.editors?.telegram_id) {
    await sendMessage(
      task.editors.telegram_id,
      `ℹ️ Your task *${title}* was marked *${fmt.fmtStatus(status)}* by management.` +
      (status === 'blocked' && reason ? `\nReason: _${reason}_` : '')
    );
  }
}

// Reopens a delivered task for a change-request round, notifies the assigned
// editor with the change notes, and tells the owners. The editor can reply to
// the change-request message with the updated file + "done" to resubmit.
//
// The original deadline governs ONLY the first delivery. Once work has been
// submitted, a stale (already-passed) deadline must not keep marking the
// revision as overdue — that's what made every revision instantly late. So we
// drop the first-round deadline here and re-arm the past-deadline nudge flag,
// unless the owner supplies a fresh, optional review deadline for this round.
// `attachments` (optional) is an array of { fileId, fileType, fileName } the owner
// chose to send along with the revision — reference material the editor should see.
// They're forwarded to the editor right after the change-request message.
async function requestChanges(task, notes, source, reviewDeadline = null, attachments = []) {
  const nextRevision = (task.revision_count || 0) + 1;
  const title = fmt.taskTitle(task);
  const editorName = task.editors?.name || 'Unassigned';

  // Reopen so the task re-enters active lists, reminders, etc. (always works).
  await db.updateTaskStatus(task.id, 'in_progress', {
    completed_at: null,
    deadline: reviewDeadline || null,
    deadline_notified_at: null,
  });

  // Re-arm the pre-deadline reminder + escalation flags for the new revision
  // deadline (best-effort — new columns; no-ops on an un-migrated schema).
  await db.rearmDeadlineFlags(task.id);

  // Stamp the round just delivered (review_log) with this change request BEFORE
  // bumping the revision count, so the history closes out the right round.
  try {
    await db.stampReviewRoundChangeRequest(task.id, notes);
  } catch (err) {
    console.warn('[Changes] Could not stamp review round in history:', err.message);
  }

  // Record the revision round (best-effort — columns may be new).
  try {
    await db.setTaskRevision(task.id, { count: nextRevision, notes });
  } catch (err) {
    console.warn('[Changes] Could not store revision metadata:', err.message);
  }

  const deadlineLine = reviewDeadline
    ? `📅 *Revision deadline:* ${fmt.fmtDeadline(reviewDeadline)}\n`
    : `📅 _No deadline set for this revision._\n`;

  const attachCount = Array.isArray(attachments) ? attachments.length : 0;
  const attachmentLine = attachCount
    ? `\n📎 *${attachCount} reference ${attachCount === 1 ? 'file' : 'files'} attached below.*\n`
    : '';

  // Notify the editor and point the task's reply-target at this new message, so
  // replying to it with the updated file resolves the right task.
  if (task.editors?.telegram_id) {
    const sent = await sendMessage(
      task.editors.telegram_id,
      `🔁 *Changes Requested* (Revision #${nextRevision})\n\n` +
      `🆔 Task: \`${fmt.taskCode(task)}\`\n` +
      `Task: *${title}*\n` +
      `Type: ${fmt.fmtType(task.type)}\n` +
      deadlineLine +
      `\n📝 *What to change:*\n_${notes}_\n` +
      attachmentLine +
      `\n👇 Tap *Done* below (or reply here) with the updated file when it's ready.`,
      kb.editorTaskButtons(task.id)
    );
    const msgId = sent?.message_id?.toString();
    if (msgId) {
      try {
        await db.updateTaskAssignmentMsgId(task.id, msgId);
      } catch (err) {
        console.warn('[Changes] Could not update reply-target message id:', err.message);
      }
    }

    // Forward the owner's reference attachments right after the notes (best-effort,
    // one at a time — a failed file shouldn't drop the rest or the whole request).
    for (const att of attachments || []) {
      try {
        await sendFile(task.editors.telegram_id, {
          fileId: att.fileId,
          fileType: att.fileType,
          caption: `📎 Reference for the requested changes — *${title}*`,
        });
      } catch (err) {
        console.warn('[Changes] Could not forward change attachment:', err.message);
      }
    }
  }

  await sendToOwners(
    `🔁 *Change Request Sent*\n\n` +
    `🆔 \`${fmt.taskCode(task)}\`\n` +
    `Task: *${title}*\n` +
    `Employee: *${editorName}*\n` +
    `Revision: #${nextRevision}\n` +
    `Deadline: ${reviewDeadline ? fmt.fmtDeadline(reviewDeadline) : 'None (optional for revisions)'}\n` +
    `Notes: _${notes}_` +
    (attachCount ? `\nAttachments: ${attachCount} file${attachCount === 1 ? '' : 's'} forwarded` : '') +
    (source ? `\n_(via ${source})_` : '')
  );
}

// ── Approval flow ──────────────────────────────────────────────────────────────
// Transitions a task into the owner-review state. Falls back to 'in_progress' if
// the DB status constraint hasn't been migrated yet (see schema.sql), so the
// "done" flow never hard-fails. Returns true when it truly entered review.
async function submitForReview(task) {
  let entered = true;
  try {
    await db.updateTaskStatus(task.id, 'submitted_for_review');
  } catch (err) {
    console.warn('[Review] Could not set submitted_for_review — run the status migration in schema.sql. Falling back to in_progress:', err.message);
    entered = false;
    try {
      await db.updateTaskStatus(task.id, 'in_progress');
    } catch (e2) {
      console.warn('[Review] Fallback status update also failed:', e2.message);
    }
  }

  // Log this delivery for the work-record history regardless of which status the
  // task landed in — the employee delivered either way (best-effort, new cols).
  try {
    await db.recordSubmission(task.id);
  } catch (err) {
    console.warn('[Review] Could not record submission in history:', err.message);
  }

  return entered;
}

// Alerts the owners that an employee has submitted work for review, with Approve /
// Request Changes buttons. Used by the text "done" path and the Done button.
// (The file-upload path attaches the same buttons to the forwarded file instead.)
async function notifyOwnersOfSubmission(editor, task) {
  const title = fmt.taskTitle(task);
  await sendToOwners(
    `📤 *Submitted for Review*\n\n` +
    `🆔 \`${fmt.taskCode(task)}\`\n` +
    `Employee: *${editor.name}*\n` +
    `Task: *${title}*\n` +
    `Type: ${fmt.fmtType(task.type)}\n` +
    `Deadline: ${fmt.fmtDeadline(task.deadline)}` +
    (task.deliverable_file_id ? `\n\n📎 Latest file shared earlier.` : ``) +
    `\n\nApprove it or request changes:`,
    kb.ownerReviewButtons(task.id)
  );
}

// Owner approves submitted work → completed. Notifies the employee and owners.
async function approveTask(task, source) {
  await db.updateTaskStatus(task.id, 'completed');
  const title = fmt.taskTitle(task);
  const editorName = task.editors?.name || 'Unassigned';

  if (task.editors?.telegram_id) {
    await sendMessage(
      task.editors.telegram_id,
      `🎉 *Approved!*\n\nYour work *${title}* was approved by management. Great job!`
    );
  }

  await sendToOwners(
    `✅ *Work Approved*\n\n` +
    `Task: *${title}*\n` +
    `Employee: *${editorName}*` +
    (source ? `\n_(via ${source})_` : '')
  );
}

// Sends an employee the assignment notification (with quick buttons) for a task
// they now own, and records the message id for reply-based matching.
async function notifyEditorOfAssignment(task, editor) {
  if (!editor?.telegram_id) return;
  const clientName = task.clients?.name || null;
  const link = task.drive_link || driveLink();
  const sent = await sendMessage(
    editor.telegram_id,
    fmt.assignmentNotification(clientName, task.project_name, task.type, task.deadline, link, task.note, task.priority, task),
    kb.editorTaskButtons(task.id)
  );
  const msgId = sent?.message_id?.toString();
  if (msgId) {
    try {
      await db.updateTaskAssignmentMsgId(task.id, msgId);
    } catch (err) {
      console.warn('[Reassign] Could not store assignment message id:', err.message);
    }
  }
}

// ── Bulk owner actions (admin portal) ────────────────────────────────────────────
// Each helper applies one operation to a list of joined task rows, notifies the
// affected employees individually, and sends owners a single summary.

async function bulkComplete(tasks, source) {
  let count = 0;
  for (const task of tasks) {
    await db.updateTaskStatus(task.id, 'completed');
    count++;
    if (task.editors?.telegram_id) {
      await sendMessage(
        task.editors.telegram_id,
        `✅ Your task *${fmt.taskTitle(task)}* was marked *Completed* by management.`
      );
    }
  }
  if (count) {
    await sendToOwners(
      `✅ *Bulk Update*\n\n${count} task${count > 1 ? 's' : ''} marked *Completed*.` +
      (source ? `\n_(via ${source})_` : '')
    );
  }
  return count;
}

async function bulkSetDeadline(tasks, deadline, source) {
  let count = 0;
  for (const task of tasks) {
    await db.setTaskDeadline(task.id, deadline);
    count++;
    if (task.editors?.telegram_id) {
      await sendMessage(
        task.editors.telegram_id,
        `📅 The deadline for *${fmt.taskTitle(task)}* was updated to *${fmt.fmtDeadline(deadline)}*.`
      );
    }
  }
  if (count) {
    await sendToOwners(
      `📅 *Bulk Update*\n\nDeadline set to *${fmt.fmtDeadline(deadline)}* on ${count} task${count > 1 ? 's' : ''}.` +
      (source ? `\n_(via ${source})_` : '')
    );
  }
  return count;
}

// Moves a single task to a new editor: updates the DB, tells the previous editor
// it left their plate, and sends the new editor the assignment notification.
// Returns false (no-op) when the task is already theirs. Does NOT message owners —
// callers decide whether to send a single-task or a bulk summary.
async function reassignTaskCore(task, newEditor) {
  if (task.assigned_to === newEditor.id) return false; // already theirs
  const oldEditor = task.editors;
  await db.setTaskAssignee(task.id, newEditor.id);
  if (oldEditor?.telegram_id) {
    await sendMessage(
      oldEditor.telegram_id,
      `ℹ️ Your task *${fmt.taskTitle(task)}* has been reassigned by management.`
    );
  }
  await notifyEditorOfAssignment(task, newEditor);
  return true;
}

// Single-task reassign with its own owner summary — used by the Telegram
// "reassign … to …" command. Returns true when the move actually happened.
async function reassignTask(task, newEditor, source) {
  const moved = await reassignTaskCore(task, newEditor);
  if (moved) {
    await sendToOwners(
      `🔄 *Task Reassigned*\n\n` +
      `Task: *${fmt.taskTitle(task)}*\n` +
      `Now with: *${newEditor.name}*` +
      (source ? `\n_(via ${source})_` : '')
    );
  }
  return moved;
}

// Re-pings the assigned editor about a task (a manual reminder), and points the
// task's reply-target at this fresh message so a quick reply still resolves it.
async function nudgeTask(task, source) {
  const editor = task.editors;
  if (!editor?.telegram_id) return false;
  const title = fmt.taskTitle(task);
  const sent = await sendMessage(
    editor.telegram_id,
    `🔔 *Reminder from management*\n\n` +
    `🆔 Task: \`${fmt.taskCode(task)}\`\n` +
    `Task: *${title}*\n` +
    `Type: ${fmt.fmtType(task.type)}\n` +
    `Deadline: ${fmt.fmtDeadline(task.deadline)}\n` +
    `Status: ${fmt.fmtStatus(task.status)}\n\n` +
    `👇 Tap a button to update it, or reply with *started* / *done* / *blocked [reason]*.`,
    kb.editorTaskButtons(task.id)
  );
  const msgId = sent?.message_id?.toString();
  if (msgId) {
    try {
      await db.updateTaskAssignmentMsgId(task.id, msgId);
    } catch (err) {
      console.warn('[Nudge] Could not update reply-target message id:', err.message);
    }
  }
  await sendToOwners(
    `🔔 *Nudge Sent*\n\n` +
    `Task: *${title}*\n` +
    `Employee: *${editor.name}*` +
    (source ? `\n_(via ${source})_` : '')
  );
  return true;
}

async function bulkReassign(tasks, newEditor, source) {
  let count = 0;
  for (const task of tasks) {
    if (await reassignTaskCore(task, newEditor)) count++;
  }
  if (count) {
    await sendToOwners(
      `🔄 *Bulk Reassign*\n\n${count} task${count > 1 ? 's' : ''} reassigned to *${newEditor.name}*.` +
      (source ? `\n_(via ${source})_` : '')
    );
  }
  return count;
}

module.exports = {
  parseDeadline,
  assignProject,
  changeTaskStatus,
  requestChanges,
  reassignTask,
  nudgeTask,
  submitForReview,
  notifyOwnersOfSubmission,
  approveTask,
  bulkComplete,
  bulkSetDeadline,
  bulkReassign,
};
