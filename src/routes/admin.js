const express = require('express');
const crypto = require('crypto');
const db = require('../db/supabase');
const fmt = require('../services/formatters');
const { assignProject, changeTaskStatus, parseDeadline, requestChanges } = require('../services/assignments');

const router = express.Router();

const ROLES = [
  { value: 'editor',           label: 'Editor' },
  { value: 'shoot',            label: 'Shoot' },
  { value: 'graphic_designer', label: 'Graphic Designer' },
  { value: 'data_sorting',     label: 'Data Sorting' },
];
const TYPES = [
  { value: 'edit',              label: 'Edit' },
  { value: 'shoot',             label: 'Shoot' },
  { value: 'graphic_designing', label: 'Graphic Designing' },
  { value: 'data_sorting',      label: 'Data Sorting' },
];
const STATUSES = ['pending', 'in_progress', 'blocked', 'completed'];

// ── Auth ───────────────────────────────────────────────────────────────────────
function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireAuth(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return next();
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const supplied = decoded.slice(decoded.indexOf(':') + 1);
    if (timingSafeEqual(supplied, password)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Framex Admin", charset="UTF-8"');
  return res.status(401).send('Authentication required.');
}

router.use(requireAuth);

// ── Helpers ──────────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function normalizeTelegramId(raw) {
  return raw.trim().replace(/[^\d]/g, '');
}

function statusBadge(status) {
  const map = { pending: ['pending', 'Pending'], in_progress: ['progress', 'In Progress'], blocked: ['blocked', 'Blocked'], completed: ['done', 'Completed'] };
  const [cls, label] = map[status] || ['pending', status];
  return `<span class="badge st-${cls}">${label}</span>`;
}

function typeBadge(type) {
  const cls = { edit: 'type-edit', shoot: 'type-shoot', graphic_designing: 'type-gd', data_sorting: 'type-ds', 'pre-production': 'pre', 'post-production': 'post' };
  return `<span class="badge ${cls[type] || 'type-edit'}">${esc(fmt.fmtType(type))}</span>`;
}

function roleBadges(roles) {
  const arr = Array.isArray(roles) ? roles : (roles ? [roles] : []);
  if (!arr.length) return '<span class="badge no-dl">—</span>';
  const cls = { editor: 'type-edit', shoot: 'type-shoot', graphic_designer: 'type-gd', data_sorting: 'type-ds' };
  const lbl = { editor: 'Editor', shoot: 'Shoot', graphic_designer: 'Graphic Designer', data_sorting: 'Data Sorting' };
  return arr.map((r) => `<span class="badge ${cls[r] || 'both'}">${esc(lbl[r] || r)}</span>`).join(' ');
}

function page(title, activeNav, body, flash = '') {
  const nav = [
    ['/admin',             'Dashboard',  'dashboard'],
    ['/admin/assign',      'Assign Work','assign'],
    ['/admin/tasks',       'Tasks',      'tasks'],
    ['/admin/changes',     'Changes',    'changes'],
    ['/admin/employees',   'Employees',  'employees'],
    ['/admin/performance', 'Performance','performance'],
    ['/admin/clients',     'Clients',    'clients'],
  ].map(([href, label, key]) =>
    `<a href="${href}" class="${key === activeNav ? 'active' : ''}">${label}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Framex Admin — ${esc(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f4f6f9; color: #1a1a2e; min-height: 100vh; }
    header { background: #1a1a2e; color: #fff; padding: 16px 32px; display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
    header h1 { font-size: 1.05rem; font-weight: 700; letter-spacing: 0.02em; }
    header .owner-tag { font-size: 0.7rem; background: #6366f1; padding: 2px 8px; border-radius: 99px; font-weight: 600; }
    nav { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
    nav a { color: #c7c9d9; text-decoration: none; font-size: 0.85rem; font-weight: 500; padding: 6px 12px; border-radius: 7px; transition: all .15s; }
    nav a:hover { background: rgba(255,255,255,.08); color: #fff; }
    nav a.active { background: #6366f1; color: #fff; }
    main { max-width: 1100px; margin: 32px auto; padding: 0 20px; display: grid; gap: 24px; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08); padding: 26px; }
    .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 18px; }
    .flash { padding: 12px 16px; border-radius: 8px; font-size: 0.875rem; margin-bottom: 18px; }
    .flash.ok  { background: #d1fae5; color: #065f46; }
    .flash.err { background: #fee2e2; color: #991b1b; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; }
    .stat { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08); padding: 20px 22px; }
    .stat .num { font-size: 2rem; font-weight: 700; line-height: 1; }
    .stat .lbl { font-size: 0.78rem; color: #6b7280; margin-top: 8px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    .stat.warn .num { color: #dc2626; }
    .stat.block .num { color: #b45309; }
    .stat.good .num { color: #059669; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 0.85rem; font-weight: 500; color: #374151; }
    label.full { grid-column: 1 / -1; }
    input, select, textarea { padding: 9px 12px; border: 1.5px solid #d1d5db; border-radius: 8px; font-size: 0.9rem; outline: none; transition: border-color .15s; font-family: inherit; }
    textarea { resize: vertical; min-height: 70px; }
    input:focus, select:focus, textarea:focus { border-color: #6366f1; }
    .hint { font-size: 0.75rem; color: #9ca3af; font-weight: 400; }
    button { padding: 10px 22px; background: #6366f1; color: #fff; border: none; border-radius: 8px; font-size: 0.88rem; font-weight: 600; cursor: pointer; transition: background .15s; }
    button:hover { background: #4f46e5; }
    button.ghost { background: #eef2ff; color: #4338ca; padding: 7px 14px; font-size: 0.8rem; }
    button.ghost:hover { background: #e0e7ff; }
    button.danger { background: #fee2e2; color: #991b1b; padding: 7px 14px; font-size: 0.8rem; }
    button.danger:hover { background: #fecaca; }
    form.inline-form { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    form.inline-form select, form.inline-form input { padding: 6px 9px; font-size: 0.8rem; }
    .submit-row { margin-top: 18px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    thead tr { border-bottom: 2px solid #f3f4f6; }
    th { text-align: left; padding: 8px 10px; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; font-weight: 600; }
    td { padding: 11px 10px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    tbody tr:last-child td { border-bottom: none; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 99px; font-size: 0.72rem; font-weight: 600; text-transform: capitalize; }
    .badge.type-edit { background: #dbeafe; color: #1d4ed8; }
    .badge.type-shoot { background: #fce7f3; color: #9d174d; }
    .badge.type-gd    { background: #ede9fe; color: #6d28d9; }
    .badge.type-ds    { background: #fef9c3; color: #854d0e; }
    .badge.pre        { background: #dbeafe; color: #1d4ed8; }
    .badge.post       { background: #fce7f3; color: #9d174d; }
    .badge.both       { background: #ede9fe; color: #6d28d9; }
    .badge.active     { background: #d1fae5; color: #065f46; }
    .badge.inactive   { background: #fee2e2; color: #991b1b; }
    .badge.st-pending  { background: #fef3c7; color: #92400e; }
    .badge.st-progress { background: #dbeafe; color: #1d4ed8; }
    .badge.st-blocked  { background: #fee2e2; color: #991b1b; }
    .badge.st-done     { background: #d1fae5; color: #065f46; }
    .badge.st-changes  { background: #ffedd5; color: #9a3412; }
    .badge.on-time     { background: #d1fae5; color: #065f46; }
    .badge.late        { background: #fee2e2; color: #991b1b; }
    .badge.no-dl       { background: #f3f4f6; color: #6b7280; }
    .note { font-size: 0.78rem; color: #6b7280; font-style: italic; margin-top: 4px; }
    .client-tag { font-size: 0.78rem; color: #6366f1; font-weight: 600; margin-bottom: 2px; }
    .overdue-flag { color: #dc2626; font-weight: 600; font-size: 0.72rem; }
    .empty { text-align: center; color: #9ca3af; padding: 28px 0; font-size: 0.875rem; }
    mono, .mono { font-family: ui-monospace, monospace; font-size: 0.8rem; }
    .rate-good { color: #059669; font-weight: 700; }
    .rate-warn { color: #d97706; font-weight: 700; }
    .rate-bad  { color: #dc2626; font-weight: 700; }
    .section-link { float: right; font-size: 0.8rem; color: #6366f1; text-decoration: none; font-weight: 500; }
    .section-link:hover { text-decoration: underline; }
    /* Role checkboxes */
    .role-checks { display: flex; gap: 16px; flex-wrap: wrap; padding: 10px 0 4px; }
    .role-checks label { flex-direction: row; align-items: center; gap: 7px; font-weight: 400; cursor: pointer; }
    .role-checks input[type=checkbox] { width: 15px; height: 15px; border: 1.5px solid #d1d5db; border-radius: 4px; padding: 0; cursor: pointer; accent-color: #6366f1; }
    /* Changes tab */
    .changes-form { display: flex; flex-direction: column; gap: 6px; min-width: 210px; }
    .changes-form textarea { min-height: 46px; font-size: 0.8rem; padding: 6px 9px; }
    .changes-form button { padding: 7px 14px; font-size: 0.8rem; align-self: flex-start; }
  </style>
</head>
<body>
  <header>
    <h1>Framex Originals</h1>
    <span class="owner-tag">Owner</span>
    <nav>${nav}</nav>
  </header>
  <main>${flash}${body}</main>
</body>
</html>`;
}

function flashFrom(query) {
  let out = '';
  if (query.ok)    out += `<div class="flash ok">${esc(query.ok)}</div>`;
  if (query.error) out += `<div class="flash err">${esc(query.error)}</div>`;
  return out;
}

function isOverdue(task) {
  return task.deadline && task.status !== 'completed' && new Date(task.deadline) < new Date();
}

function statusForm(task) {
  const opts = STATUSES.map((s) =>
    `<option value="${s}" ${s === task.status ? 'selected' : ''}>${fmt.fmtStatus(s).replace(/^[^ ]+ /, '')}</option>`
  ).join('');
  return `<form class="inline-form" method="POST" action="/admin/tasks/${task.id}/status">
    <select name="status">${opts}</select>
    <input type="text" name="reason" placeholder="reason (if blocked)" value="${esc(task.blocked_reason || '')}">
    <button class="ghost" type="submit">Update</button>
  </form>`;
}

function taskRow(task) {
  const employee = task.editors?.name || 'Unassigned';
  const clientName = task.clients?.name;
  return `<tr>
    <td>
      ${clientName ? `<div class="client-tag">${esc(clientName)}</div>` : ''}
      <strong>${esc(task.project_name)}</strong>
      ${task.note ? `<div class="note">📝 ${esc(task.note)}</div>` : ''}
    </td>
    <td>${esc(employee)}</td>
    <td>${typeBadge(task.type)}</td>
    <td>
      ${fmt.fmtDeadline(task.deadline)}
      ${isOverdue(task) ? '<div class="overdue-flag">⚠ OVERDUE</div>' : ''}
    </td>
    <td>${statusBadge(task.status)}</td>
    <td>${statusForm(task)}</td>
  </tr>`;
}

// ── Changes / Revisions helpers ─────────────────────────────────────────────────
// Reopened revision rounds keep status 'in_progress' in the DB but read as
// "Changes" here so the lifecycle (delivered → changes → done) is visible.
function changeStatusBadge(task) {
  if (task.status === 'completed') return statusBadge('completed');
  if (task.revision_count > 0) return `<span class="badge st-changes">🔁 Changes · Rev ${task.revision_count}</span>`;
  return statusBadge(task.status);
}

function fileRef(task) {
  if (!task.deliverable_file_id) return '<span class="badge no-dl">No file</span>';
  const name = task.deliverable_file_name || `(${task.deliverable_file_type || 'file'})`;
  return `<div class="mono">📎 ${esc(name)}</div>
    <div class="note">${esc(task.deliverable_file_type || '')}${task.deliverable_uploaded_at ? ' · ' + fmtDateTime(task.deliverable_uploaded_at) : ''}</div>`;
}

function changeRow(task) {
  const employee = task.editors?.name || 'Unassigned';
  const clientName = task.clients?.name;
  const notCompleted = task.status !== 'completed';
  const doneForm = notCompleted
    ? `<form method="POST" action="/admin/changes/${task.id}/done" style="margin-top:6px">
         <button class="ghost" type="submit">Mark Done</button>
       </form>`
    : '';
  return `<tr>
    <td>
      ${clientName ? `<div class="client-tag">${esc(clientName)}</div>` : ''}
      <strong>${esc(task.project_name)}</strong> ${typeBadge(task.type)}
    </td>
    <td>${esc(employee)}</td>
    <td>${fileRef(task)}</td>
    <td>${changeStatusBadge(task)}</td>
    <td>${task.revision_notes ? `<div class="note">📝 ${esc(task.revision_notes)}</div>` : '<span class="badge no-dl">—</span>'}</td>
    <td>
      <form method="POST" action="/admin/changes/${task.id}/request" class="changes-form">
        <textarea name="notes" placeholder="What needs to change?" required></textarea>
        <button type="submit">Request Changes</button>
      </form>
      ${doneForm}
    </td>
  </tr>`;
}

// ── Employee sheet helpers ────────────────────────────────────────────────────────
function fmtTurnaround(hours) {
  if (hours == null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function onTimeRateCell(rate) {
  if (rate == null) return '<span class="badge no-dl">—</span>';
  const cls = rate >= 80 ? 'rate-good' : rate >= 50 ? 'rate-warn' : 'rate-bad';
  return `<span class="${cls}">${rate}%</span>`;
}

function completionBadge(task) {
  if (!task.deadline) return '<span class="badge no-dl">No Deadline</span>';
  const late = task.completed_at && new Date(task.completed_at) > new Date(task.deadline);
  return late ? '<span class="badge late">Late</span>' : '<span class="badge on-time">On Time</span>';
}

// ── Dashboard ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const [active, overdue, completedToday, editors, thisWeek, thisMonth, history] = await Promise.all([
      db.getAllActiveTasks(),
      db.getOverdueTasks(),
      db.getCompletedToday(),
      db.getAllEditors(),
      db.getCompletedThisWeek(),
      db.getCompletedThisMonth(),
      db.getCompletedTasksHistory(30),
    ]);
    const blocked = active.filter((t) => t.status === 'blocked').length;

    const stats = `
      <div class="stats">
        <div class="stat"><div class="num">${active.length}</div><div class="lbl">Active Tasks</div></div>
        <div class="stat warn"><div class="num">${overdue.length}</div><div class="lbl">Overdue</div></div>
        <div class="stat block"><div class="num">${blocked}</div><div class="lbl">Blocked</div></div>
        <div class="stat good"><div class="num">${completedToday.length}</div><div class="lbl">Done Today</div></div>
        <div class="stat good"><div class="num">${thisWeek}</div><div class="lbl">Done This Week</div></div>
        <div class="stat good"><div class="num">${thisMonth}</div><div class="lbl">Done This Month</div></div>
        <div class="stat"><div class="num">${editors.length}</div><div class="lbl">Active Employees</div></div>
      </div>`;

    const activeRows = active.length
      ? active.map(taskRow).join('')
      : `<tr><td colspan="6" class="empty">No active tasks. <a href="/admin/assign">Assign work →</a></td></tr>`;

    const historyRows = history.length
      ? history.map((t) => `<tr>
          <td>
            ${t.clients?.name ? `<div class="client-tag">${esc(t.clients.name)}</div>` : ''}
            <strong>${esc(t.project_name)}</strong>
          </td>
          <td>${esc(t.editors?.name || 'Unknown')}</td>
          <td>${typeBadge(t.type)}</td>
          <td style="font-size:0.8rem">${fmtDateTime(t.started_at)}</td>
          <td style="font-size:0.8rem">${fmt.fmtDeadline(t.deadline)}</td>
          <td style="font-size:0.8rem">${fmtDateTime(t.completed_at)}</td>
          <td>${completionBadge(t)}</td>
        </tr>`).join('')
      : `<tr><td colspan="7" class="empty">No completed tasks yet.</td></tr>`;

    const body = `
      ${stats}
      <div class="card">
        <h2>Active Work</h2>
        <table>
          <thead><tr><th>Work</th><th>Employee</th><th>Type</th><th>Deadline</th><th>Status</th><th>Change Status</th></tr></thead>
          <tbody>${activeRows}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>Previous Work <a class="section-link" href="/admin/performance">→ Performance</a></h2>
        <table>
          <thead><tr><th>Work</th><th>Done By</th><th>Type</th><th>Started At</th><th>Deadline</th><th>Completed At</th><th>Result</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table>
      </div>`;

    res.send(page('Dashboard', 'dashboard', body, flashFrom(req.query)));
  } catch (e) {
    res.send(page('Dashboard', 'dashboard', '', `<div class="flash err">Could not load dashboard: ${esc(e.message)}</div>`));
  }
});

// ── Assign Work ───────────────────────────────────────────────────────────────────
router.get('/assign', async (req, res) => {
  let editors = [], counts = {}, clients = [], loadErr = '';
  try {
    const [eds, active, cls] = await Promise.all([db.getAllEditors(), db.getAllActiveTasks(), db.getAllActiveClients()]);
    editors = eds;
    clients = cls;
    for (const t of active) {
      if (t.assigned_to) counts[t.assigned_to] = (counts[t.assigned_to] || 0) + 1;
    }
  } catch (e) { loadErr = e.message; }

  const clientOpts = clients.length
    ? `<option value="">— Select client (optional) —</option>` +
      clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
    : `<option value="">No clients yet — add them in Clients tab</option>`;

  const typeOpts = TYPES.map((t) => `<option value="${t.value}">${t.label}</option>`).join('');

  const roleLabel = { editor: 'Editor', shoot: 'Shoot', graphic_designer: 'Graphic Designer', data_sorting: 'Data Sorting' };
  const editorOpts = editors.length
    ? editors.map((e) => {
        const roleStr = Array.isArray(e.role) ? e.role.map((r) => roleLabel[r] || r).join(', ') : (e.role || '');
        return `<option value="${e.id}">${esc(e.name)} [${esc(roleStr)}] — ${counts[e.id] || 0} active</option>`;
      }).join('')
    : '';

  const body = `
    <div class="card">
      <h2>Assign New Work</h2>
      ${loadErr ? `<div class="flash err">Could not load data: ${esc(loadErr)}</div>` : ''}
      ${!editors.length && !loadErr ? `<div class="flash err">No active employees yet. <a href="/admin/employees">Add one first →</a></div>` : ''}
      <form method="POST" action="/admin/assign">
        <div class="grid">
          <label>
            Client
            <select name="clientId">${clientOpts}</select>
            <span class="hint">Select the high-level client this work belongs to.</span>
          </label>
          <label>
            Type of Work
            <select name="type" required>${typeOpts}</select>
          </label>
          <label class="full">
            Main Work / Subtask Description
            <input type="text" name="projectName" placeholder="e.g. Brand Reel Colour Grade" required>
            <span class="hint">This is what the employee will see as their task.</span>
          </label>
          <label>
            Assign To
            <select name="editorId" required>${editorOpts}</select>
            <span class="hint">Numbers in brackets = current active tasks.</span>
          </label>
          <label>
            Deadline
            <input type="datetime-local" name="deadline">
          </label>
          <label class="full">
            Note to Employee <span class="hint">(optional — sent with the assignment on Telegram)</span>
            <textarea name="note" placeholder="e.g. Keep it under 60s, use the new brand LUT, deliver vertical 9:16."></textarea>
          </label>
        </div>
        <div class="submit-row"><button type="submit">Assign &amp; Notify Employee</button></div>
      </form>
    </div>`;

  res.send(page('Assign Work', 'assign', body, flashFrom(req.query)));
});

router.post('/assign', async (req, res) => {
  const { projectName, type, editorId, deadline, note, clientId } = req.body;
  try {
    if (!projectName || !projectName.trim()) throw new Error('Work description is required.');
    if (!TYPES.find((t) => t.value === type)) throw new Error('Invalid work type.');
    const editor = await db.getEditorById(editorId);
    if (!editor) throw new Error('Selected employee not found.');

    await assignProject({
      projectName: projectName.trim(),
      type,
      editor,
      deadline: parseDeadline(deadline),
      note: note && note.trim() ? note.trim() : null,
      source: 'Admin Portal',
      clientId: clientId || null,
    });

    res.redirect('/admin?ok=' + encodeURIComponent(`Assigned "${projectName.trim()}" to ${editor.name} — notified on Telegram.`));
  } catch (e) {
    res.redirect('/admin/assign?error=' + encodeURIComponent(e.message));
  }
});

// ── Tasks list ────────────────────────────────────────────────────────────────────
router.get('/tasks', async (req, res) => {
  try {
    const active = await db.getAllActiveTasks();
    const rows = active.length
      ? active.map(taskRow).join('')
      : `<tr><td colspan="6" class="empty">No active tasks.</td></tr>`;
    const body = `
      <div class="card">
        <h2>All Active Tasks (${active.length})</h2>
        <table>
          <thead><tr><th>Work</th><th>Employee</th><th>Type</th><th>Deadline</th><th>Status</th><th>Change Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    res.send(page('Tasks', 'tasks', body, flashFrom(req.query)));
  } catch (e) {
    res.send(page('Tasks', 'tasks', '', `<div class="flash err">Could not load tasks: ${esc(e.message)}</div>`));
  }
});

router.post('/tasks/:id/status', async (req, res) => {
  const { status, reason } = req.body;
  const back = req.headers.referer && req.headers.referer.includes('/tasks') ? '/admin/tasks' : '/admin';
  try {
    if (!STATUSES.includes(status)) throw new Error('Invalid status.');
    const task = await db.getTaskById(req.params.id);
    if (!task) throw new Error('Task not found.');
    await changeTaskStatus(task, status, status === 'blocked' ? (reason && reason.trim() ? reason.trim() : 'No reason given') : null);
    res.redirect(`${back}?ok=` + encodeURIComponent(`"${task.project_name}" marked ${fmt.fmtStatus(status).replace(/^[^ ]+ /, '')}.`));
  } catch (e) {
    res.redirect(`${back}?error=` + encodeURIComponent(e.message));
  }
});

// ── Changes / Revisions ─────────────────────────────────────────────────────────
router.get('/changes', async (req, res) => {
  try {
    const tasks = await db.getTasksWithDeliverable(100);
    const rows = tasks.length
      ? tasks.map(changeRow).join('')
      : `<tr><td colspan="6" class="empty">No files submitted yet. When an editor uploads a deliverable on Telegram, it'll appear here.</td></tr>`;
    const body = `
      <div class="card">
        <h2>Change Requests</h2>
        <p style="font-size:0.85rem;color:#6b7280;margin-bottom:16px">
          Files your editors have delivered. <strong>Request Changes</strong> reopens the task — the editor is notified on Telegram with your notes and the round is tracked as a revision (status shows <span class="badge st-changes">🔁 Changes</span>). When they resubmit and you approve, <strong>Mark Done</strong>.
        </p>
        <table>
          <thead><tr><th>Work</th><th>Employee</th><th>Reference File</th><th>Status</th><th>Latest Notes</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    res.send(page('Changes', 'changes', body, flashFrom(req.query)));
  } catch (e) {
    const hint = /deliverable|revision|column/i.test(e.message)
      ? ' — run the deliverable + revision DB migrations (see src/db/schema.sql) to enable this tab.'
      : '';
    res.send(page('Changes', 'changes', '', `<div class="flash err">Could not load change requests: ${esc(e.message)}${hint}</div>`));
  }
});

router.post('/changes/:id/request', async (req, res) => {
  const { notes } = req.body;
  try {
    if (!notes || !notes.trim()) throw new Error('Change notes are required.');
    const task = await db.getTaskById(req.params.id);
    if (!task) throw new Error('Task not found.');
    await requestChanges(task, notes.trim(), 'Admin Portal');
    res.redirect('/admin/changes?ok=' + encodeURIComponent(`Change request sent to ${task.editors?.name || 'the editor'} for "${task.project_name}".`));
  } catch (e) {
    res.redirect('/admin/changes?error=' + encodeURIComponent(e.message));
  }
});

router.post('/changes/:id/done', async (req, res) => {
  try {
    const task = await db.getTaskById(req.params.id);
    if (!task) throw new Error('Task not found.');
    await changeTaskStatus(task, 'completed', null);
    res.redirect('/admin/changes?ok=' + encodeURIComponent(`"${task.project_name}" marked Completed.`));
  } catch (e) {
    res.redirect('/admin/changes?error=' + encodeURIComponent(e.message));
  }
});

// ── Employees (management) ────────────────────────────────────────────────────────
router.get('/employees', async (req, res) => {
  let employees = [], fetchError = '';
  try {
    employees = await db.getAllEditorsIncludingInactive();
  } catch (e) { fetchError = e.message; }

  const rows = employees.length
    ? employees.map((e) => `<tr>
        <td><strong>${esc(e.name)}</strong></td>
        <td class="mono">${esc(e.telegram_id)}</td>
        <td>${roleBadges(e.role)}</td>
        <td><span class="badge ${e.active ? 'active' : 'inactive'}">${e.active ? 'Active' : 'Inactive'}</span></td>
        <td>
          <form class="inline-form" method="POST" action="/admin/employees/${e.id}/toggle">
            <button class="${e.active ? 'danger' : 'ghost'}" type="submit">${e.active ? 'Deactivate' : 'Activate'}</button>
          </form>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="empty">No employees yet.</td></tr>`;

  const roleChecks = ROLES.map((r) =>
    `<label class="checkbox-item"><input type="checkbox" name="roles" value="${r.value}"> ${r.label}</label>`
  ).join('');

  const body = `
    <div class="card">
      <h2>Add New Employee</h2>
      ${fetchError ? `<div class="flash err">Could not load employees: ${esc(fetchError)}</div>` : ''}
      <form method="POST" action="/admin/employees">
        <div class="grid">
          <label>
            Name
            <input type="text" name="name" placeholder="e.g. Rahul" required>
          </label>
          <label>
            Telegram Chat ID
            <input type="text" name="number" placeholder="123456789" required>
            <span class="hint">Message @userinfobot on Telegram to get your Chat ID.</span>
          </label>
          <label class="full">
            Roles <span class="hint">(select all that apply)</span>
            <div class="role-checks">${roleChecks}</div>
          </label>
        </div>
        <div class="submit-row"><button type="submit">Add Employee</button></div>
      </form>
    </div>

    <div class="card">
      <h2>All Employees</h2>
      <table>
        <thead><tr><th>Name</th><th>Telegram ID</th><th>Roles</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  res.send(page('Employees', 'employees', body, flashFrom(req.query)));
});

router.post('/employees', async (req, res) => {
  const { name, number } = req.body;
  let roles = req.body.roles || [];
  if (!Array.isArray(roles)) roles = [roles];
  if (!name || !number || !roles.length) {
    return res.redirect('/admin/employees?error=' + encodeURIComponent('Name, number, and at least one role are required.'));
  }
  try {
    await db.createEditor({ name: name.trim(), telegramId: normalizeTelegramId(number), roles });
    res.redirect('/admin/employees?ok=' + encodeURIComponent(`Employee "${name.trim()}" added.`));
  } catch (e) {
    res.redirect('/admin/employees?error=' + encodeURIComponent(e.message));
  }
});

router.post('/employees/:id/toggle', async (req, res) => {
  try {
    const editor = await db.getEditorById(req.params.id);
    if (!editor) throw new Error('Employee not found.');
    await db.setEditorActive(editor.id, !editor.active);
    res.redirect('/admin/employees?ok=' + encodeURIComponent(`${editor.name} is now ${!editor.active ? 'Active' : 'Inactive'}.`));
  } catch (e) {
    res.redirect('/admin/employees?error=' + encodeURIComponent(e.message));
  }
});

// Keep old /editors URL alive with a redirect so any saved bookmarks work
router.get('/editors', (req, res) => res.redirect(301, '/admin/employees'));

// ── Performance (was Employee Sheet) ─────────────────────────────────────────────
router.get('/performance', async (req, res) => {
  try {
    const stats = await db.getEmployeeStats();

    const totalAssigned  = stats.reduce((s, e) => s + e.total, 0);
    const totalCompleted = stats.reduce((s, e) => s + e.completed, 0);
    const totalOnTime    = stats.reduce((s, e) => s + e.onTime, 0);
    const totalWithDl    = stats.reduce((s, e) => s + e.onTime + e.lateCount, 0);
    const overallRate    = totalWithDl > 0 ? Math.round((totalOnTime / totalWithDl) * 100) : null;
    const activeEmployees = stats.filter((e) => e.editor.active).length;

    const summaryStats = `
      <div class="stats">
        <div class="stat"><div class="num">${activeEmployees}</div><div class="lbl">Active Employees</div></div>
        <div class="stat"><div class="num">${totalAssigned}</div><div class="lbl">Total Assigned</div></div>
        <div class="stat good"><div class="num">${totalCompleted}</div><div class="lbl">Total Completed</div></div>
        <div class="stat good"><div class="num">${overallRate != null ? overallRate + '%' : '—'}</div><div class="lbl">Overall On-Time Rate</div></div>
      </div>`;

    const rows = stats.length
      ? stats.map((s) => {
          const e = s.editor;
          return `<tr>
            <td><strong>${esc(e.name)}</strong></td>
            <td>${roleBadges(e.role)}</td>
            <td><span class="badge ${e.active ? 'active' : 'inactive'}">${e.active ? 'Active' : 'Inactive'}</span></td>
            <td style="text-align:center">${s.total}</td>
            <td style="text-align:center"><strong>${s.completed}</strong></td>
            <td style="text-align:center">${s.active}</td>
            <td style="text-align:center">${s.overdue > 0 ? `<span class="rate-bad">${s.overdue}</span>` : '0'}</td>
            <td style="text-align:center">${onTimeRateCell(s.onTimeRate)}</td>
            <td style="text-align:center">${esc(fmtTurnaround(s.avgTurnaround))}</td>
            <td style="font-size:0.8rem;color:#6b7280">${fmtDateTime(s.lastStartedAt)}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="10" class="empty">No employees yet. <a href="/admin/employees">Add one →</a></td></tr>`;

    const body = `
      ${summaryStats}
      <div class="card">
        <h2>Employee Performance</h2>
        <p style="font-size:0.8rem;color:#6b7280;margin-bottom:16px">
          <strong>On-Time Rate</strong> = completed before deadline ÷ total completed with a deadline.
          <strong>Avg Turnaround</strong> = started → completed (tasks with both timestamps).
        </p>
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Roles</th><th>Status</th>
              <th style="text-align:center">Assigned</th>
              <th style="text-align:center">Completed</th>
              <th style="text-align:center">Active</th>
              <th style="text-align:center">Overdue</th>
              <th style="text-align:center">On-Time Rate</th>
              <th style="text-align:center">Avg Turnaround</th>
              <th>Last Started</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    res.send(page('Performance', 'performance', body, flashFrom(req.query)));
  } catch (e) {
    res.send(page('Performance', 'performance', '', `<div class="flash err">Could not load performance stats: ${esc(e.message)}</div>`));
  }
});

// ── Clients ───────────────────────────────────────────────────────────────────────
router.get('/clients', async (req, res) => {
  let clients = [], fetchError = '';
  try {
    clients = await db.getAllClients();
  } catch (e) { fetchError = e.message; }

  const rows = clients.length
    ? clients.map((c) => `<tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td><span class="badge ${c.active ? 'active' : 'inactive'}">${c.active ? 'Active' : 'Inactive'}</span></td>
        <td style="font-size:0.8rem;color:#6b7280">${fmtDateTime(c.created_at)}</td>
        <td>
          <form class="inline-form" method="POST" action="/admin/clients/${c.id}/toggle">
            <button class="${c.active ? 'danger' : 'ghost'}" type="submit">${c.active ? 'Deactivate' : 'Activate'}</button>
          </form>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="empty">No clients yet.</td></tr>`;

  const body = `
    <div class="card">
      <h2>Add New Client</h2>
      ${fetchError ? `<div class="flash err">Could not load clients: ${esc(fetchError)}</div>` : ''}
      <p style="font-size:0.85rem;color:#6b7280;margin-bottom:16px">
        Clients are the high-level entities you select from a dropdown when assigning work. They appear on Telegram (type <code>clients</code> to list them) and in the Assign Work form.
      </p>
      <form method="POST" action="/admin/clients" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
        <label style="flex:1;min-width:220px">
          Client Name
          <input type="text" name="name" placeholder="e.g. Acme Brand" required>
        </label>
        <div class="submit-row" style="margin-top:0"><button type="submit">Add Client</button></div>
      </form>
    </div>

    <div class="card">
      <h2>All Clients (${clients.length})</h2>
      <table>
        <thead><tr><th>Name</th><th>Status</th><th>Added On</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  res.send(page('Clients', 'clients', body, flashFrom(req.query)));
});

router.post('/clients', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.redirect('/admin/clients?error=' + encodeURIComponent('Client name is required.'));
  }
  try {
    await db.createClient({ name: name.trim() });
    res.redirect('/admin/clients?ok=' + encodeURIComponent(`Client "${name.trim()}" added.`));
  } catch (e) {
    res.redirect('/admin/clients?error=' + encodeURIComponent(e.message));
  }
});

router.post('/clients/:id/toggle', async (req, res) => {
  try {
    const client = await db.getClientById(req.params.id);
    if (!client) throw new Error('Client not found.');
    await db.setClientActive(client.id, !client.active);
    res.redirect('/admin/clients?ok=' + encodeURIComponent(`${client.name} is now ${!client.active ? 'Active' : 'Inactive'}.`));
  } catch (e) {
    res.redirect('/admin/clients?error=' + encodeURIComponent(e.message));
  }
});

module.exports = router;
