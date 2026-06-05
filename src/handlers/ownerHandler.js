const db = require('../db/supabase');
const { sendMessage } = require('../services/telegram');
const lb = require('../services/loadBalancer');
const fmt = require('../services/formatters');
const { parseDeadline, assignProject, changeTaskStatus } = require('../services/assignments');

// Pending assignment confirmations, keyed by owner number so two owners can be
// mid-assignment at the same time without clashing.
const pendingAssignments = new Map();

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

async function handleOwnerMessage(from, body) {
  const text = body.trim().toLowerCase();

  // ── check if THIS owner is awaiting employee confirmation ────────────────────
  if (pendingAssignments.has(from)) {
    const resolved = await tryResolveConfirmation(from, body);
    if (resolved) return;
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

  // ── help ──────────────────────────────────────────────────────────────────────
  if (text === 'help') {
    await sendMessage(from, fmt.helpMenu(true));
    return;
  }

  // ── unrecognised ──────────────────────────────────────────────────────────────
  await sendMessage(from, `❓ I didn't understand that. Type *help* to see available commands.`);
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
      `new project: [client] | [main work] | [type] | deadline: [date] | note: [optional]\n\n` +
      `Types: *edit · shoot · graphic designing · data sorting*\n\n` +
      `Example:\nnew project: Acme Brand | Brand Reel | edit | deadline: 10 Jun\n\n` +
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
  pendingAssignments.set(from, { projectName, type, deadline, note, ranked, clientId: client?.id || null, clientName });
  await sendMessage(from, fmt.assignmentConfirmationPrompt(clientName, projectName, type, deadline, ranked, note));
}

// ── Assignment confirmation ────────────────────────────────────────────────────
async function tryResolveConfirmation(from, body) {
  const text = body.trim().toLowerCase();
  const { projectName, type, deadline, note, ranked, clientId, clientName } = pendingAssignments.get(from);

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

  await assignProject({ projectName, type, editor: chosenScored.editor, deadline, note, source: 'Telegram', clientId });
  pendingAssignments.delete(from);
  return true;
}

async function handleDirectAssign(from, editorName) {
  if (!pendingAssignments.has(from)) {
    await sendMessage(from, `❌ No pending assignment. Use *new project:* first.`);
    return;
  }
  const { projectName, type, deadline, note, ranked, clientId } = pendingAssignments.get(from);
  const chosenScored = ranked.find((s) =>
    s.editor.name.toLowerCase().includes(editorName.toLowerCase())
  );
  if (!chosenScored) {
    await sendMessage(from, `❌ Employee "${editorName}" not found. Reply with the number (1, 2…) or their exact name.`);
    return;
  }
  await assignProject({ projectName, type, editor: chosenScored.editor, deadline, note, source: 'Telegram', clientId });
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

module.exports = { handleOwnerMessage };
