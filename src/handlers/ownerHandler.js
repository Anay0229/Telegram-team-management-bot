const db = require('../db/supabase');
const { sendMessage } = require('../services/telegram');
const lb = require('../services/loadBalancer');
const fmt = require('../services/formatters');
const kb = require('../services/keyboards');
const { parseDeadline, assignProject, changeTaskStatus, requestChanges, reassignTask, nudgeTask } = require('../services/assignments');
const { sendDeadlineReminders, sendPreDeadlineReminders, sendEscalationAlerts } = require('../jobs/scheduler');

// Pending assignment confirmations + button-driven change-note prompts live in a
// shared module so the inline-button callback handler can read/write them too.
const { pendingAssignments, pendingChangeNotes } = require('./pendingState');

// Type keyword → canonical type
const TYPE_ALIASES = {
  'edit': 'edit', 'editing': 'edit',
  'shoot': 'shoot', 'shooting': 'shoot',
  'graphic': 'graphic_designing', 'graphic designing': 'graphic_designing',
  'graphic design': 'graphic_designing', 'gd': 'graphic_designing',
  'data': 'data_sorting', 'data sorting': 'data_sorting', 'ds': 'data_sorting',
  // legacy
  'pre': 'edit', 'pre-production': 'edit',
  'post': 'edit', 'post-production': 'edit',
};

function resolveType(raw) {
  return TYPE_ALIASES[raw.toLowerCase().trim()] || null;
}

// True when the text is a recognised owner command, so a pending change-note
// prompt won't swallow it.
function isKnownOwnerCommand(body) {
  const t = body.trim().toLowerCase();
  if (['clients', 'team status', 'overdue', 'completed today', 'test reminders', 'run reminders', 'help'].includes(t)) return true;
  if (/^(new project\s*:|mark\s+|changes?\b|revisions?\b|revise\b|redo\b|assign to\s+|reassign\s+|nudge\s+|remind\s+|leave\s+|back\s+)/i.test(t)) return true;
  if (/\bstatus$/i.test(t)) return true; // "[employee name] status"
  return false;
}

async function handleOwnerMessage(from, body, quotedMsgId) {
  const text = body.trim().toLowerCase();

  // ── awaiting change notes (owner tapped the 🔁 Request Changes button) ───────
  // Capture the next free-text message as the revision notes, unless they typed
  // another recognised command instead.
  if (pendingChangeNotes.has(from)) {
    if (isKnownOwnerCommand(body)) {
      pendingChangeNotes.delete(from);
    } else {
      const { taskId, attachments } = pendingChangeNotes.get(from);
      pendingChangeNotes.delete(from);
      const task = await db.getTaskById(taskId);
      if (task) {
        await requestChanges(task, body.trim(), 'Telegram (button)', null, attachments || []);
      } else {
        await sendMessage(from, `❌ I couldn't find that task anymore.`);
      }
      return;
    }
  }

  // ── check if THIS owner is awaiting employee confirmation ────────────────────
  if (pendingAssignments.has(from)) {
    const resolved = await tryResolveConfirmation(from, body);
    if (resolved) return;
  }

  // ── reply to a forwarded deliverable file = request changes on that task ──────
  if (quotedMsgId) {
    let task = null;
    try {
      task = await db.getTaskByDeliverableOwnerMsg(from, quotedMsgId);
    } catch (err) {
      console.warn('[Owner] Deliverable-reply lookup failed:', err.message);
    }
    if (task) {
      const notes = body.replace(/^(changes?|revisions?|revise|redo)\b\s*[:\-]?\s*/i, '').trim() || 'No details provided';
      await requestChanges(task, notes, 'Telegram (reply to file)');
      return;
    }
  }

  // ── new project intake ────────────────────────────────────────────────────────
  if (text.startsWith('new project:') || text.startsWith('new project :')) {
    await handleNewProject(from, body);
    return;
  }

  // ── list clients ──────────────────────────────────────────────────────────────
  if (text === 'clients') {
    const clients = await db.getAllActiveClients();
    if (!clients.length) {
      await sendMessage(from, `📋 No clients added yet. Add them from the admin portal.`);
    } else {
      const lines = clients.map((c, i) => `${i + 1}. *${c.name}*`).join('\n');
      await sendMessage(from, `📋 *Available Clients*\n\n${lines}\n\nUse any of these names when creating a project.`);
    }
    return;
  }

  // ── mark [project/client] [status] [reason] ───────────────────────────────────
  if (text.startsWith('mark ')) {
    const parsed = parseOwnerMark(body);
    if (!parsed) {
      await sendMessage(
        from,
        `❌ *Invalid format.*\n\nUse:\nmark [work or client] [done | in progress | blocked | pending] [reason]\n\nExample:\nmark Brand Reel done`
      );
      return;
    }
    await handleOwnerMark(from, parsed);
    return;
  }

  // ── changes [project/client] | [notes] (request a revision) ───────────────────
  if (/^(changes?|revisions?|revise|redo)\b/i.test(text)) {
    const parsed = parseChangesCommand(body);
    if (!parsed) {
      await sendMessage(
        from,
        `❌ *Invalid format.*\n\nUse:\nchanges [work or client] | [what to change]\n\nExample:\nchanges Brand Reel | fix the intro and redo color grade\n\n` +
        `💡 Or just *reply to the file the editor sent* with the change notes.`
      );
      return;
    }
    await handleOwnerChanges(from, parsed);
    return;
  }

  // ── reassign [project/client] to [name] ───────────────────────────────────────
  if (/^reassign\b/i.test(text)) {
    await handleOwnerReassign(from, body);
    return;
  }

  // ── nudge / remind [project or employee] ──────────────────────────────────────
  if (/^(nudge|remind)\b/i.test(text)) {
    await handleOwnerNudge(from, body);
    return;
  }

  // ── leave / back [employee] (mark on-leave / available) ───────────────────────
  if (/^(leave|back)\b/i.test(text)) {
    await handleOwnerAvailability(from, body);
    return;
  }

  // ── assign to [name] ──────────────────────────────────────────────────────────
  if (text.startsWith('assign to ')) {
    const editorName = body.slice(10).trim();
    await handleDirectAssign(from, editorName);
    return;
  }

  // ── team status ───────────────────────────────────────────────────────────────
  if (text === 'team status') {
    const tasks = await db.getAllActiveTasks();
    await sendMessage(from, fmt.teamStatusMessage(tasks));
    return;
  }

  // ── [employee name] status ────────────────────────────────────────────────────
  const editorStatusMatch = text.match(/^(.+)\s+status$/);
  if (editorStatusMatch) {
    const name = editorStatusMatch[1].trim();
    const editor = await db.getEditorByName(name);
    if (!editor) {
      await sendMessage(from, `❌ No employee found matching "${name}".`);
      return;
    }
    const tasks = await db.getTasksForEditorWithJoin(editor.id);
    if (!tasks.length) {
      await sendMessage(from, `✅ *${editor.name}* has no active tasks.`);
    } else {
      const lines = tasks.map((t) => fmt.taskLine(t));
      await sendMessage(from, `📋 *${editor.name}'s Tasks* (${tasks.length})\n\n${lines.join('\n\n')}`);
    }
    return;
  }

  // ── overdue ───────────────────────────────────────────────────────────────────
  if (text === 'overdue') {
    const tasks = await db.getOverdueTasks();
    await sendMessage(from, fmt.overdueMessage(tasks));
    return;
  }

  // ── completed today ───────────────────────────────────────────────────────────
  if (text === 'completed today') {
    const tasks = await db.getCompletedToday();
    await sendMessage(from, fmt.completedTodayMessage(tasks));
    return;
  }

  // ── test reminders (run the deadline checks on demand) ──────────────────────────
  if (text === 'test reminders' || text === 'run reminders') {
    await sendMessage(from, `⏳ Running deadline checks now…`);
    const [pre, rem, esc] = await Promise.all([
      sendPreDeadlineReminders(),
      sendDeadlineReminders(),
      sendEscalationAlerts(),
    ]);
    const err = pre.error || rem.error || esc.error;
    await sendMessage(
      from,
      `✅ *Reminder check complete*\n\n` +
      `⏳ Pre-deadline heads-ups: *${pre.sent || 0}* sent\n` +
      `⏰ Deadline reminders: *${rem.sent || 0}* sent (${rem.due || 0} at/past deadline)\n` +
      `🚨 Escalations: *${esc.sent || 0}* sent\n\n` +
      (err ? `⚠️ Some checks errored: _${err}_\n\n` : ``) +
      `_Reminders fire automatically before and when a deadline is reached._`
    );
    return;
  }

  // ── help ──────────────────────────────────────────────────────────────────────
  if (text === 'help') {
    await sendMessage(from, fmt.helpMenu(true));
    return;
  }

  // ── unrecognised ──────────────────────────────────────────────────────────────
  await sendMessage(from, `❓ I didn't understand that. Type *help* to see available commands.`);
}

// ── Owner file uploads ─────────────────────────────────────────────────────────
// The only time an owner's uploaded file is meaningful is while they're putting
// together a change request (after tapping 🔁 Request Changes). We queue the file
// as a reference attachment. A file sent WITHOUT a caption waits for more files /
// the notes; a file WITH a caption uses that caption as the notes and sends the
// whole request right away. Any other owner file is ignored (returns false).
async function handleOwnerFile(from, file) {
  if (!pendingChangeNotes.has(from)) return false;

  const pending = pendingChangeNotes.get(from);
  pending.attachments.push({
    fileId: file.fileId,
    fileType: file.fileType,
    fileName: file.fileName || null,
  });

  const caption = (file.caption || '').trim();
  const forWhom = pending.title ? `the employee for *${pending.title}*` : 'the employee';

  // Caption present → it doubles as the change notes; finalise immediately.
  if (caption) {
    pendingChangeNotes.delete(from);
    const task = await db.getTaskById(pending.taskId);
    if (task) {
      await requestChanges(task, caption, 'Telegram (button)', null, pending.attachments);
    } else {
      await sendMessage(from, `❌ I couldn't find that task anymore.`);
    }
    return true;
  }

  // No caption → keep collecting; the owner's next text message is the notes.
  const n = pending.attachments.length;
  await sendMessage(
    from,
    `📎 Attached *${n}* file${n === 1 ? '' : 's'}. Send more if you like, then *type your change notes* and I'll deliver everything to ${forWhom}.`
  );
  return true;
}

// ── New project parsing ────────────────────────────────────────────────────────
// Format: new project: [client] | [main work] | [type] | deadline: [date] | note: [text]
// Client can be a name (partial match against the DB) or omitted with "-".
async function handleNewProject(from, body) {
  const raw = body.replace(/^new project\s*:\s*/i, '');
  const parts = raw.split('|').map((p) => p.trim());

  if (parts.length < 3) {
    await sendMessage(
      from,
      `❌ *Invalid format.*\n\n` +
      `new project: [client] | [main work] | [type] | deadline: [date] | priority: [optional] | note: [optional]\n\n` +
      `Types: *edit · shoot · graphic designing · data sorting*\n` +
      `Priority: *low · normal · high · urgent* (defaults to normal)\n\n` +
      `Example:\nnew project: Acme Brand | Brand Reel | edit | deadline: 10 Jun | priority: high\n\n` +
      `Type *clients* to see the list of available clients.`
    );
    return;
  }

  const clientQuery = parts[0];
  const projectName = parts[1];
  const rawType = parts[2];

  const type = resolveType(rawType);
  if (!type) {
    await sendMessage(
      from,
      `❌ Unknown type "*${rawType}*".\n\nValid types: *edit · shoot · graphic designing · data sorting*`
    );
    return;
  }

  // Resolve deadline
  let deadline = null;
  const deadlinePart = parts.find((p) => /deadline/i.test(p));
  if (deadlinePart) {
    deadline = parseDeadline(deadlinePart.replace(/deadline\s*:/i, '').trim());
  }

  // Optional note
  let note = null;
  const notePart = parts.find((p) => /^note\s*:/i.test(p));
  if (notePart) note = notePart.replace(/^note\s*:/i, '').trim() || null;

  // Optional priority (low | normal | high | urgent) — defaults to normal.
  let priority = 'normal';
  const priorityPart = parts.find((p) => /^priority\s*:/i.test(p));
  if (priorityPart) {
    const raw = priorityPart.replace(/^priority\s*:/i, '').trim().toLowerCase();
    if (['low', 'normal', 'high', 'urgent'].includes(raw)) priority = raw;
  }

  // Resolve client by name
  let client = null;
  if (clientQuery && clientQuery !== '-') {
    const matches = await db.getClientByName(clientQuery);
    if (!matches.length) {
      await sendMessage(
        from,
        `❌ No client found matching "*${clientQuery}*".\n\nType *clients* to see the list, or add new ones from the portal.`
      );
      return;
    }
    if (matches.length > 1) {
      const list = matches.map((c, i) => `${i + 1}. *${c.name}*`).join('\n');
      await sendMessage(
        from,
        `⚠️ Multiple clients match "*${clientQuery}*":\n\n${list}\n\nPlease be more specific.`
      );
      return;
    }
    client = matches[0];
  }

  const ranked = await lb.getRankedEditors(type);
  if (!ranked.length) {
    await sendMessage(from, `❌ No available employees found for *${fmt.fmtType(type)}* work.`);
    return;
  }

  const clientName = client?.name || null;
  pendingAssignments.set(from, { projectName, type, deadline, note, priority, ranked, clientId: client?.id || null, clientName });
  await sendMessage(
    from,
    fmt.assignmentConfirmationPrompt(clientName, projectName, type, deadline, ranked, note, priority),
    kb.assignmentButtons(ranked)
  );
}

// ── Assignment confirmation ────────────────────────────────────────────────────
async function tryResolveConfirmation(from, body) {
  const text = body.trim().toLowerCase();
  const { projectName, type, deadline, note, priority, ranked, clientId, clientName } = pendingAssignments.get(from);

  let chosenScored = null;

  const num = parseInt(text, 10);
  if (!isNaN(num) && num >= 1 && num <= ranked.length) {
    chosenScored = ranked[num - 1];
  }
  if (!chosenScored) {
    chosenScored = ranked.find((s) => s.editor.name.toLowerCase().includes(text));
  }
  if (!chosenScored && text.startsWith('assign to ')) {
    const name = text.slice(10).trim();
    chosenScored = ranked.find((s) => s.editor.name.toLowerCase().includes(name));
  }

  if (!chosenScored) return false;

  await assignProject({ projectName, type, editor: chosenScored.editor, deadline, note, priority, source: 'Telegram', clientId });
  pendingAssignments.delete(from);
  return true;
}

async function handleDirectAssign(from, editorName) {
  if (!pendingAssignments.has(from)) {
    await sendMessage(from, `❌ No pending assignment. Use *new project:* first.`);
    return;
  }
  const { projectName, type, deadline, note, priority, ranked, clientId } = pendingAssignments.get(from);
  const chosenScored = ranked.find((s) =>
    s.editor.name.toLowerCase().includes(editorName.toLowerCase())
  );
  if (!chosenScored) {
    await sendMessage(from, `❌ Employee "${editorName}" not found. Reply with the number (1, 2…) or their exact name.`);
    return;
  }
  await assignProject({ projectName, type, editor: chosenScored.editor, deadline, note, priority, source: 'Telegram', clientId });
  pendingAssignments.delete(from);
}

// ── Owner-driven status change ─────────────────────────────────────────────────
function parseOwnerMark(body) {
  const rest = body.replace(/^mark\s+/i, '').trim();
  const patterns = [
    { status: 'completed',   re: /\s+(done|completed|complete|finished)\b/i },
    { status: 'in_progress', re: /\s+(in[\s-]?progress|started|start|wip|ongoing)\b/i },
    { status: 'blocked',     re: /\s+blocked\b/i },
    { status: 'pending',     re: /\s+(pending|reset|not started|todo)\b/i },
  ];
  for (const p of patterns) {
    const m = rest.match(p.re);
    if (m && m.index > 0) {
      const project = rest.slice(0, m.index).trim();
      const after = rest.slice(m.index + m[0].length).trim();
      if (!project) continue;
      const reason = p.status === 'blocked'
        ? (after.replace(/^[\s\-–—:]+/, '').trim() || 'No reason given')
        : null;
      return { project, status: p.status, reason };
    }
  }
  return null;
}

// ── Change requests ──────────────────────────────────────────────────────────
// Format: changes [work or client] | [what to change] | [optional review deadline]
// The 3rd segment is optional — revisions have no deadline unless one is given.
function parseChangesCommand(body) {
  const rest = body.replace(/^(changes?|revisions?|revise|redo)\b\s*:?\s*/i, '').trim();
  const parts = rest.split('|');
  if (parts.length < 2) return null;
  const project = parts[0].trim();
  const notes = parts[1].trim();
  const deadlineStr = parts.length >= 3 ? parts.slice(2).join('|').trim() : '';
  if (!project || !notes) return null;
  return { project, notes, deadlineStr: deadlineStr || null };
}

async function handleOwnerChanges(from, { project, notes, deadlineStr }) {
  const matches = await db.findTasksByProjectNameAnyStatus(project);

  if (!matches.length) {
    await sendMessage(from, `❌ No task matching "${project}".`);
    return;
  }
  if (matches.length > 1) {
    const list = matches
      .slice(0, 8)
      .map((t, i) => `${i + 1}. *${fmt.taskTitle(t)}* — ${t.editors?.name || 'Unassigned'} (${fmt.fmtStatus(t.status)})`)
      .join('\n');
    await sendMessage(
      from,
      `⚠️ Multiple tasks match "${project}":\n\n${list}\n\nPlease use the full work description, or reply to the editor's file instead.`
    );
    return;
  }

  // Optional review deadline for this revision round — only set if it parses.
  let reviewDeadline = null;
  if (deadlineStr) {
    reviewDeadline = parseDeadline(deadlineStr);
    if (!reviewDeadline) {
      await sendMessage(from, `⚠️ I couldn't read the review deadline "${deadlineStr}", so I'm sending the changes without one.`);
    }
  }

  await requestChanges(matches[0], notes, 'Telegram', reviewDeadline);
}

async function handleOwnerMark(from, { project, status, reason }) {
  const matches = await db.findActiveTasksByProjectName(project);

  if (!matches.length) {
    await sendMessage(from, `❌ No active task matching "${project}".`);
    return;
  }
  if (matches.length > 1) {
    const list = matches
      .map((t, i) => `${i + 1}. *${fmt.taskTitle(t)}* — ${t.editors?.name || 'Unassigned'} (${fmt.fmtStatus(t.status)})`)
      .join('\n');
    await sendMessage(
      from,
      `⚠️ Multiple tasks match "${project}":\n\n${list}\n\nPlease use the full work description.`
    );
    return;
  }

  await changeTaskStatus(matches[0], status, reason);
}

// ── Reassign ───────────────────────────────────────────────────────────────────
// Format: reassign [work or client] to [employee name]
async function handleOwnerReassign(from, body) {
  const rest = body.replace(/^reassign\b\s*:?\s*/i, '').trim();
  const m = rest.match(/^(.*\S)\s+to\s+(.+)$/i);
  if (!m) {
    await sendMessage(
      from,
      `❌ *Invalid format.*\n\nUse:\nreassign [work or client] to [employee]\n\nExample:\nreassign Brand Reel to Priya`
    );
    return;
  }
  const project = m[1].trim();
  const editorName = m[2].trim();

  const matches = await db.findActiveTasksByProjectName(project);
  if (!matches.length) {
    await sendMessage(from, `❌ No active task matching "${project}".`);
    return;
  }
  if (matches.length > 1) {
    const list = matches
      .map((t, i) => `${i + 1}. *${fmt.taskTitle(t)}* — ${t.editors?.name || 'Unassigned'} (${fmt.fmtStatus(t.status)})`)
      .join('\n');
    await sendMessage(from, `⚠️ Multiple tasks match "${project}":\n\n${list}\n\nPlease use the full work description.`);
    return;
  }

  const editor = await db.getEditorByName(editorName);
  if (!editor) {
    await sendMessage(from, `❌ No employee found matching "${editorName}".`);
    return;
  }

  const moved = await reassignTask(matches[0], editor, 'Telegram');
  if (!moved) {
    await sendMessage(from, `ℹ️ *${fmt.taskTitle(matches[0])}* is already assigned to *${editor.name}*.`);
  }
}

// ── Availability (on-leave) ─────────────────────────────────────────────────────
// Format: leave [employee]  → on leave (skipped when assigning)
//         back  [employee]  → available again
async function handleOwnerAvailability(from, body) {
  const m = body.match(/^(leave|back)\b\s*:?\s*(.+)$/i);
  if (!m || !m[2].trim()) {
    await sendMessage(from, `❌ Use: *leave [employee]* to put someone on leave, or *back [employee]* when they return.`);
    return;
  }
  const available = m[1].toLowerCase() === 'back';
  const name = m[2].trim();
  const editor = await db.getEditorByName(name);
  if (!editor) {
    await sendMessage(from, `❌ No employee found matching "${name}".`);
    return;
  }
  try {
    await db.setEditorAvailable(editor.id, available);
  } catch (err) {
    await sendMessage(from, `⚠️ Couldn't update availability — the *available* column may need the database migration.\n_${err.message}_`);
    return;
  }
  await sendMessage(
    from,
    available
      ? `✅ *${editor.name}* is back and available for new work.`
      : `🌴 *${editor.name}* is now *on leave* — they'll be skipped when assigning new work. Existing tasks stay with them.`
  );
}

// ── Nudge ──────────────────────────────────────────────────────────────────────
// Format: nudge [work or client]  — or —  nudge [employee name]
// Tries a task match first, then falls back to nudging all of an employee's work.
async function handleOwnerNudge(from, body) {
  const target = body.replace(/^(nudge|remind)\b\s*:?\s*/i, '').trim();
  if (!target) {
    await sendMessage(from, `❌ Use: nudge [work or client] — or — nudge [employee name].`);
    return;
  }

  const matches = await db.findActiveTasksByProjectName(target);
  if (matches.length === 1) {
    const ok = await nudgeTask(matches[0], 'Telegram');
    if (!ok) await sendMessage(from, `⚠️ *${fmt.taskTitle(matches[0])}* has no reachable employee to nudge.`);
    return;
  }
  if (matches.length > 1) {
    const list = matches
      .map((t, i) => `${i + 1}. *${fmt.taskTitle(t)}* — ${t.editors?.name || 'Unassigned'} (${fmt.fmtStatus(t.status)})`)
      .join('\n');
    await sendMessage(from, `⚠️ Multiple tasks match "${target}":\n\n${list}\n\nPlease use the full work description, or nudge the employee by name.`);
    return;
  }

  // No task matched — treat the target as an employee and nudge all their work.
  const editor = await db.getEditorByName(target);
  if (!editor) {
    await sendMessage(from, `❌ No task or employee matching "${target}".`);
    return;
  }
  const tasks = await db.getTasksForEditorWithJoin(editor.id);
  if (!tasks.length) {
    await sendMessage(from, `✅ *${editor.name}* has no active tasks to nudge.`);
    return;
  }
  let nudged = 0;
  for (const t of tasks) {
    // getTasksForEditorWithJoin doesn't join editors; attach so nudgeTask can reach them.
    t.editors = { name: editor.name, telegram_id: editor.telegram_id };
    if (await nudgeTask(t, 'Telegram')) nudged++;
  }
  await sendMessage(from, `🔔 Sent ${nudged} reminder${nudged === 1 ? '' : 's'} to *${editor.name}*.`);
}

module.exports = { handleOwnerMessage, handleOwnerFile };
