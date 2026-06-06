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

function taskLine(task, editorName) {
  const name = editorName || '';
  const title = taskTitle(task);
  return `• *${title}* (${fmtType(task.type)})\n  Status: ${fmtStatus(task.status)}\n  Deadline: ${fmtDeadline(task.deadline)}${name ? `\n  Employee: ${name}` : ''}${task.blocked_reason ? `\n  Reason: ${task.blocked_reason}` : ''}`;
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

function assignmentConfirmationPrompt(clientName, projectName, type, deadline, rankedEditors, note) {
  const title = clientName ? `${clientName} — ${projectName}` : projectName;
  const lines = rankedEditors.slice(0, 5).map((s, i) => editorLoadSummary(s, i));
  return (
    `📋 *New Work Received*\n` +
    `Client: *${clientName || '—'}*\n` +
    `Work: *${projectName}*\n` +
    `Type: ${fmtType(type)}\n` +
    `Deadline: ${fmtDeadline(deadline)}\n` +
    (note ? `Note: _${note}_\n` : '') +
    `\n` +
    `*Ranked Employees (least loaded first):*\n` +
    lines.join('\n') +
    `\n\nReply with the employee's *number* (1, 2…) or *name* to assign.`
  );
}

function assignmentNotification(clientName, projectName, type, deadline, driveLink, note) {
  const title = clientName ? `${clientName} — ${projectName}` : projectName;
  return (
    `🎬 *New Work Assigned to You*\n\n` +
    (clientName ? `Client: *${clientName}*\n` : '') +
    `Work: *${projectName}*\n` +
    `Type: ${fmtType(type)}\n` +
    `Deadline: ${fmtDeadline(deadline)}\n` +
    (note ? `\n📝 *Note from management:*\n_${note}_\n` : '') +
    `\n📁 *Drive Folder:* ${driveLink}\n\n` +
    `↩️ *Tip:* reply to *this* message with *started*, *done*, or *blocked [reason]* to update exactly this task.\n` +
    `📎 When it's ready, reply here with the *file* — I'll forward it to the owners. Add caption *done* to finish in one step.\n` +
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

function helpMenu(isOwner) {
  if (isOwner) {
    return (
      `📖 *Owner Commands*\n\n` +
      `*new project: [client] | [main work] | [type] | deadline: [date] | note: [optional]*\n` +
      `  Types: edit · shoot · graphic designing · data sorting\n` +
      `  Example: new project: Acme Brand | Brand Reel | edit | deadline: 10 Jun\n\n` +
      `*clients*\n  → List all available clients\n\n` +
      `*assign to [name]*\n  → Confirm employee after seeing load summary\n\n` +
      `*mark [project or client] [done | in progress | blocked | pending] [reason]*\n  → Set any task's status\n\n` +
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
    `When you have several tasks, *reply to the assignment message* (or add its number) to update the right one:\n\n` +
    `*started* / *started 2*\n  → Mark a task as In Progress\n\n` +
    `*done* / *done 2*\n  → Mark a task as Completed\n\n` +
    `*blocked [reason]* / *blocked 2 [reason]*\n  → Mark Blocked and alert the owners\n\n` +
    `📎 *Send a file*\n  → Reply to a task's message with the file and I'll forward it to the owners. Caption it *done* to also mark the task Completed.\n\n` +
    `*my tasks*\n  → See all your active tasks (with numbers)\n\n` +
    `*send raw folder*\n  → Get Raw Files Drive link\n\n` +
    `*send final folder*\n  → Get Final Data Drive link\n\n` +
    `*help*\n  → Show this menu`
  );
}

module.exports = {
  fmtDeadline,
  fmtStatus,
  fmtType,
  taskTitle,
  assignmentConfirmationPrompt,
  assignmentNotification,
  teamStatusMessage,
  overdueMessage,
  completedTodayMessage,
  editorTaskList,
  dailyDigest,
  helpMenu,
  taskLine,
};
