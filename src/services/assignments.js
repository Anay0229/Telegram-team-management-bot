// Shared assignment logic used by BOTH the Telegram owner flow and the admin portal.

const db = require('../db/supabase');
const { sendMessage, sendToOwners } = require('./telegram');
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

async function assignProject({ projectName, type, editor, deadline, note, source, clientId }) {
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
  });

  const sent = await sendMessage(
    editor.telegram_id,
    fmt.assignmentNotification(clientName, projectName, type, deadline, link, note),
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
    (clientName ? `Client: *${clientName}*\n` : '') +
    `Work: *${projectName}*\n` +
    `Employee: *${editor.name}*\n` +
    `Type: ${fmt.fmtType(type)}\n` +
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
async function requestChanges(task, notes, source) {
  const nextRevision = (task.revision_count || 0) + 1;
  const title = fmt.taskTitle(task);
  const editorName = task.editors?.name || 'Unassigned';

  // Reopen so the task re-enters active lists, reminders, etc. (always works).
  await db.updateTaskStatus(task.id, 'in_progress', { completed_at: null });

  // Record the revision round (best-effort — columns may be new).
  try {
    await db.setTaskRevision(task.id, { count: nextRevision, notes });
  } catch (err) {
    console.warn('[Changes] Could not store revision metadata:', err.message);
  }

  // Notify the editor and point the task's reply-target at this new message, so
  // replying to it with the updated file resolves the right task.
  if (task.editors?.telegram_id) {
    const sent = await sendMessage(
      task.editors.telegram_id,
      `🔁 *Changes Requested* (Revision #${nextRevision})\n\n` +
      `Task: *${title}*\n` +
      `Type: ${fmt.fmtType(task.type)}\n\n` +
      `📝 *What to change:*\n_${notes}_\n\n` +
      `👇 Tap *Done* below (or reply here) with the updated file when it's ready.`,
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
  }

  await sendToOwners(
    `🔁 *Change Request Sent*\n\n` +
    `Task: *${title}*\n` +
    `Employee: *${editorName}*\n` +
    `Revision: #${nextRevision}\n` +
    `Notes: _${notes}_` +
    (source ? `\n_(via ${source})_` : '')
  );
}

// ── Approval flow ──────────────────────────────────────────────────────────────
// Transitions a task into the owner-review state. Falls back to 'in_progress' if
// the DB status constraint hasn't been migrated yet (see schema.sql), so the
// "done" flow never hard-fails. Returns true when it truly entered review.
async function submitForReview(task) {
  try {
    await db.updateTaskStatus(task.id, 'submitted_for_review');
    return true;
  } catch (err) {
    console.warn('[Review] Could not set submitted_for_review — run the status migration in schema.sql. Falling back to in_progress:', err.message);
    try {
      await db.updateTaskStatus(task.id, 'in_progress');
    } catch (e2) {
      console.warn('[Review] Fallback status update also failed:', e2.message);
    }
    return false;
  }
}

// Alerts the owners that an employee has submitted work for review, with Approve /
// Request Changes buttons. Used by the text "done" path and the Done button.
// (The file-upload path attaches the same buttons to the forwarded file instead.)
async function notifyOwnersOfSubmission(editor, task) {
  const title = fmt.taskTitle(task);
  await sendToOwners(
    `📤 *Submitted for Review*\n\n` +
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
    fmt.assignmentNotification(clientName, task.project_name, task.type, task.deadline, link, task.note),
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

async function bulkReassign(tasks, newEditor, source) {
  let count = 0;
  for (const task of tasks) {
    const oldEditor = task.editors;
    if (task.assigned_to === newEditor.id) continue; // already theirs
    await db.setTaskAssignee(task.id, newEditor.id);
    count++;
    // Let the previous owner know it left their plate.
    if (oldEditor?.telegram_id) {
      await sendMessage(
        oldEditor.telegram_id,
        `ℹ️ Your task *${fmt.taskTitle(task)}* has been reassigned by management.`
      );
    }
    await notifyEditorOfAssignment(task, newEditor);
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
  submitForReview,
  notifyOwnersOfSubmission,
  approveTask,
  bulkComplete,
  bulkSetDeadline,
  bulkReassign,
};
