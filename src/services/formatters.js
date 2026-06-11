function fmtDeadline(deadline) {
  if (!deadline) return 'No deadline';
  return new Date(deadline).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtStatus(status) {
  const map = {
    pending: '⏳ Pending',
    in_progress: '🔄 In Progress',
    blocked: '🚫 Blocked',
    submitted_for_review: '📤 Submitted for Review',
    completed: '✅ Completed',
  };
  return map[status] || status;
}

function fmtType(type) {
  const map = {
    'edit': 'Edit',
    'shoot': 'Shoot',
    'graphic_designing': 'Graphic Designing',
    'data_sorting': 'Data Sorting',
    // Legacy — kept so old tasks display correctly
    'pre-production': 'Pre-Production',
    'post-production': 'Post-Production',
  };
  return map[type] || type;
}

// Returns "ClientName — MainWork" or just "MainWork" when no client is attached.
function taskTitle(task) {
  const client = task.clients?.name;
  return client ? `${client} — ${task.project_name}` : task.project_name;
}

// Short priority badge. 'normal' (and unknown / un-migrated) returns '' so the
// common case adds no noise; only low/high/urgent show a tag.
function fmtPriority(priority) {
  const map = { urgent: '🔴 Urgent', high: '🟠 High', low: '⚪ Low' };
  return map[priority] || '';
}

function taskLine(task, editorName) {
  const name = editorName || '';
  const title = taskTitle(task);
  const rev = task.revision_count ? ` 🔁 Rev ${task.revision_count}` : '';
  const pr = fmtPriority(task.priority);
  const prTag = pr ? ` ${pr}` : '';
  return `• *${title}* (${fmtType(task.type)})${prTag}${rev}\n  Status: ${fmtStatus(task.status)}\n  Deadline: ${fmtDeadline(task.deadline)}${name ? `\n  Employee: ${name}` : ''}${task.blocked_reason ? `\n  Reason: ${task.blocked_reason}` : ''}`;
}

function editorLoadSummary(scored, index) {
  const active = scored.activeTasks.length;
  const urgent = scored.activeTasks.filter((t) => {
    const now = Date.now();
    return t.deadline && new Date(t.deadline).getTime() - now <= 48 * 60 * 60 * 1000;
  }).length;
  const roles = Array.isArray(scored.editor.role) ? scored.editor.role.join(', ') : scored.editor.role;
  return `${index + 1}. *${scored.editor.name}* (${roles}) — Load: ${scored.score} (${active} active, ${urgent} urgent)`;
}

function assignmentConfirmationPrompt(clientName, projectName, type, deadline, rankedEditors, note, priority) {
  const title = clientName ? `${clientName} — ${projectName}` : projectName;
  const lines = rankedEditors.slice(0, 5).map((s, i) => editorLoadSummary(s, i));
  const pr = fmtPriority(priority);
  return (
    `📋 *New Work Received*\n` +
    `Client: *${clientName || '—'}*\n` +
    `Work: *${projectName}*\n` +
    `Type: ${fmtType(type)}\n` +
    (pr ? `Priority: ${pr}\n` : '') +
    `Deadline: ${fmtDeadline(deadline)}\n` +
    (note ? `Note: _${note}_\n` : '') +
    `\n` +
    `*Ranked Employees (least loaded first):*\n` +
    lines.join('\n') +
    `\n\n👇 *Tap an employee below* to assign, or reply with their *number* (1, 2…) or *name*.`
  );
}

function assignmentNotification(clientName, projectName, type, deadline, driveLink, note, priority) {
  const title = clientName ? `${clientName} — ${projectName}` : projectName;
  const pr = fmtPriority(priority);
  return (
    `🎬 *New Work Assigned to You*\n\n` +
    (clientName ? `Client: *${clientName}*\n` : '') +
    `Work: *${projectName}*\n` +
    `Type: ${fmtType(type)}\n` +
    (pr ? `Priority: ${pr}\n` : '') +
    `Deadline: ${fmtDeadline(deadline)}\n` +
    (note ? `\n📝 *Note from management:*\n_${note}_\n` : '') +
    `\n📁 *Drive Folder:* ${driveLink}\n\n` +
    `👇 *Tap a button below* to update this task, or reply to this message with *started*, *done*, or *blocked [reason]*.\n` +
    `📎 When it's ready, reply here with the *file* — I'll forward it to the owners. Add caption *done* to submit it for review.\n` +
    `Type *help* for all commands.`
  );
}

function teamStatusMessage(activeTasks) {
  if (!activeTasks.length) return '✅ No active work right now. Team is free!';
  const byEditor = {};
  for (const task of activeTasks) {
    const name = task.editors?.name || 'Unknown';
    if (!byEditor[name]) byEditor[name] = [];
    byEditor[name].push(task);
  }
  const lines = [];
  for (const [name, tasks] of Object.entries(byEditor)) {
    lines.push(`*${name}* (${tasks.length} task${tasks.length > 1 ? 's' : ''})`);
    for (const t of tasks) lines.push(`  ${taskLine(t)}`);
  }
  return `📊 *Team Status*\n\n${lines.join('\n')}`;
}

function overdueMessage(tasks) {
  if (!tasks.length) return '✅ No overdue tasks.';
  const lines = tasks.map((t) => taskLine(t, t.editors?.name));
  return `⚠️ *Overdue Tasks* (${tasks.length})\n\n${lines.join('\n\n')}`;
}

function completedTodayMessage(tasks) {
  if (!tasks.length) return 'No tasks completed today yet.';
  const lines = tasks.map((t) => `• *${taskTitle(t)}* — ${t.editors?.name || 'Unknown'}`);
  return `✅ *Completed Today* (${tasks.length})\n\n${lines.join('\n')}`;
}

function editorTaskList(tasks) {
  if (!tasks.length) return '✅ You have no active tasks right now.';
  const lines = tasks.map((t, i) => `*${i + 1}.* ${taskLine(t)}`);
  return (
    `📋 *Your Active Tasks* (${tasks.length})\n\n${lines.join('\n\n')}\n\n` +
    `_To update one: reply to its assignment message, or type e.g. *done 2* / *started 1* / *blocked 2 [reason]*._`
  );
}

function dailyDigest(activeTasks, overdueTasks, completedToday) {
  const sections = [];
  sections.push(
    `☀️ *Good morning — Framex Daily Digest*\n` +
    `${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}\n`
  );
  sections.push(`📊 *Active Tasks:* ${activeTasks.length}`);

  if (overdueTasks.length) {
    sections.push(`\n⚠️ *Overdue (${overdueTasks.length}):*`);
    overdueTasks.forEach((t) => sections.push(`  • ${taskTitle(t)} — ${t.editors?.name || '?'} (due ${fmtDeadline(t.deadline)})`));
  }

  if (completedToday.length) {
    sections.push(`\n✅ *Completed Yesterday/Today (${completedToday.length}):*`);
    completedToday.forEach((t) => sections.push(`  • ${taskTitle(t)} — ${t.editors?.name || '?'}`));
  }

  const blocked = activeTasks.filter((t) => t.status === 'blocked');
  if (blocked.length) {
    sections.push(`\n🚫 *Blocked (${blocked.length}):*`);
    blocked.forEach((t) => sections.push(`  • ${taskTitle(t)} — ${t.editors?.name || '?'}${t.blocked_reason ? ': ' + t.blocked_reason : ''}`));
  }

  return sections.join('\n');
}

// A heads-up sent to the assigned editor a set number of hours before a deadline.
function preDeadlineReminder(task, hoursLeft) {
  const when = hoursLeft >= 1
    ? `in about *${Math.round(hoursLeft)} hour${Math.round(hoursLeft) === 1 ? '' : 's'}*`
    : `in *under an hour*`;
  return (
    `⏳ *Heads-up — deadline approaching*\n\n` +
    `Your task *${taskTitle(task)}* is due ${when}.\n` +
    `Deadline: ${fmtDeadline(task.deadline)}\n\n` +
    `Reply *done* when it's ready, or *blocked [reason]* if you're stuck.`
  );
}

// Lower rank = more important; used to sort an editor's task list.
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

// Personalized morning digest for ONE editor. Returns null when they have no
// active tasks so the scheduler can skip them (no "you have 0 tasks" spam).
function editorDailyDigest(editor, tasks) {
  if (!tasks || !tasks.length) return null;
  const now = Date.now();
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const sorted = [...tasks].sort((a, b) => {
    const pr = (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2);
    if (pr !== 0) return pr;
    const ad = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const bd = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    return ad - bd;
  });

  const overdue = sorted.filter((t) => t.deadline && new Date(t.deadline).getTime() < now);
  const dueToday = sorted.filter((t) => {
    if (!t.deadline) return false;
    const d = new Date(t.deadline).getTime();
    return d >= now && d <= endOfToday.getTime();
  });

  let header = `☀️ *Good morning, ${editor.name}!*\n` +
    `You have *${tasks.length}* active task${tasks.length === 1 ? '' : 's'}.`;
  if (overdue.length) header += `\n⚠️ *${overdue.length} overdue*`;
  if (dueToday.length) header += `\n📅 *${dueToday.length} due today*`;

  const lines = sorted.map((t, i) => `*${i + 1}.* ${taskLine(t)}`);
  return (
    `${header}\n\n${lines.join('\n\n')}\n\n` +
    `_Tap a task's buttons, or reply *done* / *started* / *blocked [reason]* (add its number if you have several)._`
  );
}

function helpMenu(isOwner) {
  if (isOwner) {
    return (
      `📖 *Owner Commands*\n\n` +
      `*new project: [client] | [main work] | [type] | deadline: [date] | priority: [optional] | note: [optional]*\n` +
      `  Types: edit · shoot · graphic designing · data sorting\n` +
      `  Priority: low · normal · high · urgent (defaults to normal)\n` +
      `  Example: new project: Acme Brand | Brand Reel | edit | deadline: 10 Jun | priority: high\n\n` +
      `*clients*\n  → List all available clients\n\n` +
      `*assign to [name]*\n  → Confirm employee after seeing load summary\n\n` +
      `*mark [project or client] [done | in progress | blocked | pending] [reason]*\n  → Set any task's status\n\n` +
      `*reassign [work or client] to [employee]*\n  → Move a task to a different employee\n\n` +
      `*nudge [work or client]* _or_ *nudge [employee]*\n  → Re-ping an employee about a task (or all their tasks)\n\n` +
      `*leave [employee]* _/_ *back [employee]*\n  → Put an employee on leave (skipped when assigning) or bring them back\n\n` +
      `*changes [project or client] | [what to change] | [deadline (optional)]*\n  → Reopen a delivered task and send the editor revision notes\n  → _Revisions have no deadline unless you add one as a 3rd part_\n  → _Or just reply to the editor's file with the notes_\n\n` +
      `✅ *Approvals*\n  → When an employee submits work, you get *Approve* / *Request Changes* buttons. Approve completes it; Request Changes reopens it for a revision.\n  → _After tapping Request Changes you can attach reference files/videos (or paste a folder link) before sending your notes._\n\n` +
      `*team status*\n  → All employees and active tasks\n\n` +
      `*[employee name] status*\n  → Drill-down on specific employee\n\n` +
      `*overdue*\n  → All tasks past deadline\n\n` +
      `*completed today*\n  → Tasks finished in last 24 hours\n\n` +
      `*test reminders*\n  → Run the deadline checks right now and see what was sent\n\n` +
      `_All owners share these commands and get the same notifications._`
    );
  }
  return (
    `📖 *Your Commands*\n\n` +
    `💡 Every task message has *quick buttons* — tap 🔄 Started, ✅ Done, or 🚫 Blocked to update it instantly.\n\n` +
    `Prefer typing? When you have several tasks, *reply to the assignment message* (or add its number):\n\n` +
    `*started* / *started 2*\n  → Mark a task as In Progress\n\n` +
    `*done* / *done 2*\n  → Submit a task for owner review\n\n` +
    `*blocked [reason]* / *blocked 2 [reason]*\n  → Mark Blocked and alert the owners\n\n` +
    `📎 *Send a file*\n  → Reply to a task's message with the file and I'll forward it to the owners. Caption it *done* to submit it for review.\n\n` +
    `✅ *Approval*\n  → When you submit work it goes to the owners to *approve* or *request changes* — you'll be notified either way.\n\n` +
    `🔁 *Revisions*\n  → If management asks for changes, the task reopens. Reply to that message with the updated file and *done* to resubmit.\n\n` +
    `*my tasks*\n  → See all your active tasks (with numbers)\n\n` +
    `🌴 *leave* / *available*\n  → Going off for a bit? Send *leave* to pause new assignments; send *available* when you're back. Your current tasks stay with you.\n\n` +
    `*send raw folder*\n  → Get Raw Files Drive link\n\n` +
    `*send final folder*\n  → Get Final Data Drive link\n\n` +
    `*help*\n  → Show this menu`
  );
}

module.exports = {
  fmtDeadline,
  fmtStatus,
  fmtType,
  fmtPriority,
  taskTitle,
  assignmentConfirmationPrompt,
  assignmentNotification,
  teamStatusMessage,
  overdueMessage,
  completedTodayMessage,
  editorTaskList,
  dailyDigest,
  editorDailyDigest,
  preDeadlineReminder,
  helpMenu,
  taskLine,
};
