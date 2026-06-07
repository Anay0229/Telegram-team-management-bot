// Shared assignment logic used by BOTH the Telegram owner flow and the admin portal.

const db = require('../db/supabase');
const { sendMessage, sendToOwners } = require('./telegram');
const fmt = require('./formatters');
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

// Drive folder mapping for the new task types
function driveLink(type) {
  switch (type) {
    case 'shoot':
    case 'data_sorting':
      return config.drive.rawFiles;
    case 'edit':
    case 'graphic_designing':
    default:
      return config.drive.finalData;
  }
}

async function assignProject({ projectName, type, editor, deadline, note, source, clientId }) {
  const client = clientId ? await db.getClientById(clientId) : null;
  const clientName = client?.name || null;
  const link = driveLink(type);

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
    fmt.assignmentNotification(clientName, projectName, type, deadline, link, note)
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
      `↩️ When it's ready, *reply to this message* with the updated file and send *done* (or caption the file *done*).`
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

module.exports = { parseDeadline, assignProject, changeTaskStatus, requestChanges };
