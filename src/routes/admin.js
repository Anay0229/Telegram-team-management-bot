const express = require('express');
const crypto = require('crypto');
const db = require('../db/supabase');
const fmt = require('../services/formatters');
const {
  assignProject, changeTaskStatus, parseDeadline, requestChanges,
  approveTask, bulkComplete, bulkSetDeadline, bulkReassign,
} = require('../services/assignments');

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
const STATUSES = ['pending', 'in_progress', 'blocked', 'submitted_for_review', 'completed'];

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

// Dynamic HTML: let the browser keep a copy but revalidate every time. Combined
// with Express's automatic ETag on string bodies, an unchanged page returns a
// bodiless 304 - saving the phone from re-sending the whole page on a revisit.
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
});

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
  const map = { pending: ['pending', 'Pending'], in_progress: ['progress', 'In Progress'], blocked: ['blocked', 'Blocked'], submitted_for_review: ['review', 'In Review'], completed: ['done', 'Completed'] };
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/admin.css">
</head>
<body>
  <header>
    <div class="brand">Framex Originals<span class="dot">.</span></div>
    <span class="owner-tag">Owner</span>
    <nav>${nav}</nav>
  </header>
  <main>
    <div class="page-head">
      <div class="eyebrow">Admin Console</div>
      <h1 class="page-title">${esc(title)}</h1>
    </div>
    ${flash}${body}
  </main>
</body>
</html>`;
}

function flashFrom(query) {
  let out = '';
  if (query.ok)    out += `<div class="flash ok">${esc(query.ok)}</div>`;
  if (query.error) out += `<div class="flash err">${esc(query.error)}</div>`;
  return out;
}

// Work that's been submitted for review (or completed) isn't overdue — the
// employee delivered on time; the deadline no longer applies once it's in review.
function isOverdue(task) {
  if (!task.deadline) return false;
  if (task.status === 'completed' || task.status === 'submitted_for_review') return false;
  return new Date(task.deadline) < new Date();
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

function taskRow(task, selectable = false) {
  const employee = task.editors?.name || 'Unassigned';
  const clientName = task.clients?.name;
  const checkCell = selectable
    ? `<td class="check-col"><input type="checkbox" class="row-check" name="taskIds" value="${task.id}" form="bulkForm"></td>`
    : '';
  return `<tr>
    ${checkCell}
    <td>
      ${clientName ? `<div class="client-tag">${esc(clientName)}</div>` : ''}
      <a class="row-link" href="/admin/tasks/${task.id}"><strong>${esc(task.project_name)}</strong></a>
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
  if (task.status === 'submitted_for_review') {
    return task.revision_count > 0
      ? `<span class="badge st-review">📤 In Review · Rev ${task.revision_count}</span>`
      : statusBadge('submitted_for_review');
  }
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
  const approveForm = notCompleted
    ? `<form method="POST" action="/admin/changes/${task.id}/approve" style="margin-top:6px">
         <button class="ghost" type="submit">✅ Approve</button>
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
        <small style="color:var(--muted-fg);font-size:.72rem;margin-bottom:-4px">Revision deadline (optional)</small>
        <input type="datetime-local" name="reviewDeadline" style="font-size:.8rem">
        <button type="submit">Request Changes</button>
      </form>
      ${approveForm}
    </td>
  </tr>`;
}

// Row for the "Awaiting Your Approval" queue — work an employee has submitted.
function approvalRow(task) {
  const employee = task.editors?.name || 'Unassigned';
  const clientName = task.clients?.name;
  const submitted = task.deliverable_uploaded_at || task.revision_requested_at;
  return `<tr>
    <td>
      ${clientName ? `<div class="client-tag">${esc(clientName)}</div>` : ''}
      <strong>${esc(task.project_name)}</strong> ${typeBadge(task.type)}
      ${task.revision_count ? `<div class="note">🔁 Revision ${task.revision_count}</div>` : ''}
    </td>
    <td>${esc(employee)}</td>
    <td>${fileRef(task)}</td>
    <td style="font-size:0.8rem;color:var(--muted-fg)">${submitted ? fmtDateTime(submitted) : '—'}</td>
    <td>
      <form method="POST" action="/admin/changes/${task.id}/approve">
        <button type="submit">✅ Approve</button>
      </form>
      <form method="POST" action="/admin/changes/${task.id}/request" class="changes-form" style="margin-top:8px">
        <textarea name="notes" placeholder="Or describe what needs to change…" required></textarea>
        <small style="color:var(--muted-fg);font-size:.72rem;margin-bottom:-4px">Revision deadline (optional)</small>
        <input type="datetime-local" name="reviewDeadline" style="font-size:.8rem">
        <button class="ghost" type="submit">🔁 Request Changes</button>
      </form>
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

// Was the employee's FIRST delivery on time? Compares first_submitted_at against
// the original deadline (initial_deadline). Falls back to the live deadline for
// never-revised rows where the migration's backfill applies; otherwise "Not
// recorded" for tasks predating the history feature.
function firstSubmissionBadge(task) {
  const submitted = task.first_submitted_at;
  const deadline = task.initial_deadline || (task.revision_count ? null : task.deadline);
  if (!submitted || !deadline) return '<span class="badge no-dl">Not recorded</span>';
  const late = new Date(submitted) > new Date(deadline);
  return late ? '<span class="badge late">Late</span>' : '<span class="badge on-time">On Time</span>';
}

// ── Task detail timeline (per-task lifecycle) ────────────────────────────────────
function tlOnTimeBadge(entry) {
  if (entry.on_time == null) return '<span class="badge no-dl">No Deadline</span>';
  return entry.on_time ? '<span class="badge on-time">On Time</span>' : '<span class="badge late">Late</span>';
}

function tlItem(label, time, body, tone = '') {
  return `<div class="tl-item${tone ? ' ' + tone : ''}">
    <div class="tl-dot"></div>
    <div class="tl-body">
      <div class="tl-label">${esc(label)}${time && time !== '—' ? `<span class="tl-time">${time}</span>` : ''}</div>
      ${body ? `<div class="tl-detail">${body}</div>` : ''}
    </div>
  </div>`;
}

// Builds the vertical lifecycle timeline for a single task. Reads review_log when
// present; otherwise degrades to the scalar columns for older tasks.
function renderTaskTimeline(task) {
  const items = [];

  // 1. Assigned — with the ORIGINAL deadline the work was given.
  const initial = task.initial_deadline || (task.revision_count ? null : task.deadline);
  items.push(tlItem('Assigned', fmtDateTime(task.created_at), `Initial deadline: <strong>${fmt.fmtDeadline(initial)}</strong>`));

  // 2. Started
  if (task.started_at) items.push(tlItem('Started', fmtDateTime(task.started_at), ''));

  // 3. Each delivery round (+ any change request that followed it).
  const log = Array.isArray(task.review_log) ? task.review_log : [];
  if (log.length) {
    log.forEach((entry) => {
      const label = entry.round === 0 ? 'First Submission' : `Resubmission · Rev ${entry.round}`;
      items.push(tlItem(label, fmtDateTime(entry.submitted_at),
        `Round deadline: <strong>${fmt.fmtDeadline(entry.deadline)}</strong> &nbsp; ${tlOnTimeBadge(entry)}`, 'good'));
      if (entry.changes_requested_at) {
        items.push(tlItem('Changes Requested', fmtDateTime(entry.changes_requested_at),
          entry.notes ? `<div class="note">📝 ${esc(entry.notes)}</div>` : '', 'accent'));
      }
    });
  } else {
    items.push(`<div class="note" style="margin:4px 0 12px">Round-by-round history wasn't recorded for this task (created before the work-record update). Showing what's available.</div>`);
    if (task.revision_count) {
      items.push(tlItem('Revisions', fmtDateTime(task.revision_requested_at),
        `${task.revision_count} round${task.revision_count > 1 ? 's' : ''} requested.${task.revision_notes ? `<div class="note">📝 ${esc(task.revision_notes)}</div>` : ''}`, 'accent'));
    }
  }

  // 4. Final outcome.
  if (task.status === 'completed') {
    items.push(tlItem('Approved & Completed', fmtDateTime(task.completed_at), statusBadge('completed'), 'good'));
  } else {
    items.push(tlItem('Current Status', '', statusBadge(task.status), task.status === 'blocked' ? 'accent' : ''));
  }

  return `<div class="timeline">${items.join('')}</div>`;
}

// A segmented bar visualising how the active workload breaks down by status,
// plus an overdue flag. Fills what would otherwise be empty space under the stats.
function workloadSnapshot(active, overdueCount) {
  const counts = { pending: 0, in_progress: 0, blocked: 0, submitted_for_review: 0 };
  for (const t of active) if (counts[t.status] != null) counts[t.status]++;
  const total = active.length;

  const segs = [
    { label: 'In Progress', color: '#FAFAFA', n: counts.in_progress },
    { label: 'Pending',      color: '#FBBF24', n: counts.pending },
    { label: 'In Review',    color: '#60A5FA', n: counts.submitted_for_review },
    { label: 'Blocked',      color: '#FF3D00', n: counts.blocked },
  ];

  const bar = total
    ? `<div class="wl-bar">${segs.filter((s) => s.n > 0).map((s) =>
        `<div class="wl-seg" style="flex-grow:${s.n};flex-basis:0;background:${s.color}" title="${s.label}: ${s.n}">${s.n}</div>`
      ).join('')}</div>`
    : `<div class="wl-empty">No active work right now — the team is clear.</div>`;

  const legend = segs.map((s) =>
    `<span class="wl-item"><span class="wl-dot" style="background:${s.color}"></span>${s.label} <strong>${s.n}</strong></span>`
  ).join('') +
    `<span class="wl-item overdue"><span class="wl-dot" style="background:transparent;border:2px solid var(--accent)"></span>Overdue <strong>${overdueCount}</strong></span>`;

  return `<div class="workload">
    <div class="wl-head">
      <h2>Workload Snapshot</h2>
      <span class="wl-total"><strong>${total}</strong> active task${total === 1 ? '' : 's'}</span>
    </div>
    ${bar}
    <div class="wl-legend">${legend}</div>
  </div>`;
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
    const awaiting = active.filter((t) => t.status === 'submitted_for_review').length;

    const stats = `
      <div class="stats">
        <div class="stat"><div class="num">${active.length}</div><div class="lbl">Active Tasks</div></div>
        <div class="stat warn"><div class="num">${overdue.length}</div><div class="lbl">Overdue</div></div>
        <div class="stat block"><div class="num">${blocked}</div><div class="lbl">Blocked</div></div>
        <div class="stat review"><div class="num">${awaiting}</div><div class="lbl">Awaiting Approval</div></div>
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
            <a class="row-link" href="/admin/tasks/${t.id}"><strong>${esc(t.project_name)}</strong></a>
          </td>
          <td>${esc(t.editors?.name || 'Unknown')}</td>
          <td>${typeBadge(t.type)}</td>
          <td style="font-size:0.8rem">${fmtDateTime(t.started_at)}</td>
          <td style="font-size:0.8rem">${fmtDateTime(t.first_submitted_at || t.deliverable_uploaded_at)}</td>
          <td>${firstSubmissionBadge(t)}</td>
          <td>${statusBadge(t.status)}<div style="font-size:0.75rem;color:var(--muted-fg);margin-top:6px">${fmtDateTime(t.completed_at)}</div></td>
        </tr>`).join('')
      : `<tr><td colspan="7" class="empty">No completed tasks yet.</td></tr>`;

    const body = `
      ${stats}
      ${workloadSnapshot(active, overdue.length)}
      <div class="card">
        <h2>Active Work</h2>
        <table>
          <thead><tr><th>Work</th><th>Employee</th><th>Type</th><th>Deadline</th><th>Status</th><th>Change Status</th></tr></thead>
          <tbody>${activeRows}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>Previous Work <a class="section-link" href="/admin/performance">→ Performance</a></h2>
        <p style="font-size:0.85rem;color:var(--muted-fg);margin-bottom:16px">Showing the 1st submission and final outcome. <strong>Click any work</strong> to see its full lifecycle — initial deadline, every review round, and approval.</p>
        <table>
          <thead><tr><th>Work</th><th>Done By</th><th>Type</th><th>Started</th><th>1st Submitted</th><th>1st Result</th><th>Final</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table>
        <p style="font-size:0.78rem;color:var(--muted-fg);margin-top:18px">
          🧪 Testing: <a class="row-link" href="/admin/test/seed-history">Seed a demo task</a> (full lifecycle) · <a class="row-link" href="/admin/test/cleanup">Clear test data</a>
        </p>
      </div>`;

    res.send(page('Dashboard', 'dashboard', body, flashFrom(req.query)));
  } catch (e) {
    res.send(page('Dashboard', 'dashboard', '', `<div class="flash err">Could not load dashboard: ${esc(e.message)}</div>`));
  }
});

// ── Task detail — full lifecycle timeline ───────────────────────────────────────
router.get('/tasks/:id', async (req, res) => {
  try {
    const task = await db.getTaskById(req.params.id);
    if (!task) {
      return res.send(page('Task', 'tasks', '', `<div class="flash err">Task not found.</div>`));
    }
    const clientName = task.clients?.name;
    const title = clientName ? `${clientName} — ${task.project_name}` : task.project_name;
    const body = `
      <p style="margin-bottom:20px"><a class="row-link" href="/admin">← Back to Dashboard</a></p>
      <div class="card">
        <h2>${esc(task.project_name)}</h2>
        <div class="task-meta">
          ${clientName ? `<span class="client-tag" style="margin:0">${esc(clientName)}</span>` : ''}
          ${typeBadge(task.type)}
          <span>Employee: <strong>${esc(task.editors?.name || 'Unassigned')}</strong></span>
          ${statusBadge(task.status)}
        </div>
        ${task.note ? `<div class="note">📝 ${esc(task.note)}</div>` : ''}
        <h3 style="margin:28px 0 18px;font-size:1rem;letter-spacing:-0.01em">Lifecycle</h3>
        ${renderTaskTimeline(task)}
      </div>`;
    res.send(page(title, 'tasks', body, flashFrom(req.query)));
  } catch (e) {
    res.send(page('Task', 'tasks', '', `<div class="flash err">Could not load task: ${esc(e.message)}</div>`));
  }
});

// ── Test / demo endpoints ───────────────────────────────────────────────────────
// Seed a fully-lived-out task (assigned → started → 1st delivery on time →
// changes requested → late resubmission → approved) so the work-record history
// and timeline can be exercised WITHOUT the Telegram bot. Drives the real db
// functions (no Telegram notifications), then opens the new task's detail page.
const TEST_PREFIX = 'TEST — ';
router.get('/test/seed-history', async (req, res) => {
  try {
    const editors = await db.getAllEditors();
    if (!editors.length) {
      return res.redirect('/admin?error=' + encodeURIComponent('Add at least one employee first, then seed a test task.'));
    }
    const editor = editors[0];
    const now = Date.now();
    const initialDeadline = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(); // +2 days → 1st submission on time
    const reviewDeadline  = new Date(now - 6 * 60 * 60 * 1000).toISOString();        // 6h ago → resubmission late
    // Tolerate the approval-status migration not being run — fall back to in_progress.
    const toReview = async (id) => {
      try { await db.updateTaskStatus(id, 'submitted_for_review'); }
      catch { await db.updateTaskStatus(id, 'in_progress'); }
    };

    // 1) Assign
    const task = await db.createTask({
      projectName: `${TEST_PREFIX}Lifecycle Demo ${new Date().toLocaleTimeString('en-IN')}`,
      type: 'edit',
      assignedTo: editor.id,
      deadline: initialDeadline,
      driveLink: null,
      note: 'Seeded by /admin/test/seed-history — safe to delete.',
      clientId: null,
    });
    await db.markInitialDeadline(task.id, initialDeadline);

    // 2) Started  3) First delivery (on time)
    await db.updateTaskStatus(task.id, 'in_progress');
    await toReview(task.id);
    await db.recordSubmission(task.id);

    // 4) Owner requests changes, with a (now past) review deadline
    await db.stampReviewRoundChangeRequest(task.id, 'Tighten the intro and fix the audio levels.');
    await db.setTaskRevision(task.id, { count: 1, notes: 'Tighten the intro and fix the audio levels.' });
    await db.updateTaskStatus(task.id, 'in_progress', { deadline: reviewDeadline, completed_at: null, deadline_notified_at: null });

    // 5) Late resubmission  6) Approved
    await toReview(task.id);
    await db.recordSubmission(task.id);
    await db.updateTaskStatus(task.id, 'completed');

    res.redirect(`/admin/tasks/${task.id}?ok=` + encodeURIComponent('Seeded a demo task with a full lifecycle. Use /admin/test/cleanup to remove test tasks.'));
  } catch (e) {
    res.redirect('/admin?error=' + encodeURIComponent(`Could not seed test task: ${e.message}`));
  }
});

// Remove every seeded test task (project name starts with "TEST — ").
router.get('/test/cleanup', async (req, res) => {
  try {
    const n = await db.deleteTasksByNamePrefix(TEST_PREFIX);
    res.redirect('/admin?ok=' + encodeURIComponent(`Removed ${n} test task${n === 1 ? '' : 's'}.`));
  } catch (e) {
    res.redirect('/admin?error=' + encodeURIComponent(`Cleanup failed: ${e.message}`));
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
    const [active, editors] = await Promise.all([db.getAllActiveTasks(), db.getAllEditors()]);
    const rows = active.length
      ? active.map((t) => taskRow(t, true)).join('')
      : `<tr><td colspan="7" class="empty">No active tasks.</td></tr>`;

    const roleLabel = { editor: 'Editor', shoot: 'Shoot', graphic_designer: 'Graphic Designer', data_sorting: 'Data Sorting' };
    const editorOpts = editors.length
      ? `<option value="">— Employee —</option>` + editors.map((e) => {
          const roleStr = Array.isArray(e.role) ? e.role.map((r) => roleLabel[r] || r).join(', ') : (e.role || '');
          return `<option value="${e.id}">${esc(e.name)}${roleStr ? ` [${esc(roleStr)}]` : ''}</option>`;
        }).join('')
      : `<option value="">No employees</option>`;

    // The bulk form lives outside the table; row checkboxes associate to it via
    // form="bulkForm". Each button overrides the action with formaction so one set
    // of selected tasks can drive several operations. Server-rendered throughout —
    // the small script only adds the select-all convenience.
    const bulkBar = active.length ? `
      <form id="bulkForm" method="POST" action="/admin/tasks/bulk/complete" class="bulk-bar">
        <div class="bulk-count"><span id="selCount">0</span> selected</div>
        <div class="bulk-field">
          <label style="margin:0">Assign / Reassign to</label>
          <select name="editorId">${editorOpts}</select>
        </div>
        <button type="submit" formaction="/admin/tasks/bulk/reassign">Reassign Selected</button>
        <div class="bulk-field">
          <label style="margin:0">Set deadline</label>
          <input type="datetime-local" name="deadline">
        </div>
        <button type="submit" formaction="/admin/tasks/bulk/deadline">Set Deadline</button>
        <button class="ghost" type="submit" formaction="/admin/tasks/bulk/complete">Mark Complete</button>
      </form>` : '';

    const body = `
      <div class="card">
        <h2>All Active Tasks (${active.length})</h2>
        <p>Tick the tasks you want, then use the bar above to <strong>reassign</strong>, <strong>set a shared deadline</strong>, or <strong>mark them complete</strong> in one go. The per-row dropdown still changes a single task's status.</p>
        ${bulkBar}
        <table>
          <thead><tr>
            <th class="check-col"><input type="checkbox" class="check-all" title="Select all"></th>
            <th>Work</th><th>Employee</th><th>Type</th><th>Deadline</th><th>Status</th><th>Change Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <script>
        (function () {
          var all = document.querySelector('.check-all');
          var boxes = Array.prototype.slice.call(document.querySelectorAll('.row-check'));
          var count = document.getElementById('selCount');
          function refresh() {
            var n = boxes.filter(function (b) { return b.checked; }).length;
            if (count) count.textContent = n;
            if (all) all.checked = n > 0 && n === boxes.length;
          }
          if (all) all.addEventListener('change', function () {
            boxes.forEach(function (b) { b.checked = all.checked; });
            refresh();
          });
          boxes.forEach(function (b) { b.addEventListener('change', refresh); });
          var form = document.getElementById('bulkForm');
          if (form) form.addEventListener('submit', function (e) {
            if (!boxes.some(function (b) { return b.checked; })) {
              e.preventDefault();
              alert('Select at least one task first.');
            }
          });
        })();
      </script>`;
    res.send(page('Tasks', 'tasks', body, flashFrom(req.query)));
  } catch (e) {
    res.send(page('Tasks', 'tasks', '', `<div class="flash err">Could not load tasks: ${esc(e.message)}</div>`));
  }
});

// ── Bulk task actions ─────────────────────────────────────────────────────────
// Normalises the posted taskIds (single value arrives as a string), loads the
// joined task rows, and delegates to the shared bulk helpers in assignments.js.
function parseTaskIds(body) {
  let ids = body.taskIds || [];
  if (!Array.isArray(ids)) ids = [ids];
  return ids.filter(Boolean);
}

async function loadTasks(ids) {
  const tasks = [];
  for (const id of ids) {
    const t = await db.getTaskById(id);
    if (t) tasks.push(t);
  }
  return tasks;
}

router.post('/tasks/bulk/complete', async (req, res) => {
  try {
    const ids = parseTaskIds(req.body);
    if (!ids.length) throw new Error('Select at least one task.');
    const tasks = await loadTasks(ids);
    const n = await bulkComplete(tasks, 'Admin Portal');
    res.redirect('/admin/tasks?ok=' + encodeURIComponent(`Marked ${n} task${n === 1 ? '' : 's'} complete.`));
  } catch (e) {
    res.redirect('/admin/tasks?error=' + encodeURIComponent(e.message));
  }
});

router.post('/tasks/bulk/deadline', async (req, res) => {
  try {
    const ids = parseTaskIds(req.body);
    if (!ids.length) throw new Error('Select at least one task.');
    const deadline = parseDeadline(req.body.deadline);
    if (!deadline) throw new Error('Enter a valid deadline.');
    const tasks = await loadTasks(ids);
    const n = await bulkSetDeadline(tasks, deadline, 'Admin Portal');
    res.redirect('/admin/tasks?ok=' + encodeURIComponent(`Updated the deadline on ${n} task${n === 1 ? '' : 's'}.`));
  } catch (e) {
    res.redirect('/admin/tasks?error=' + encodeURIComponent(e.message));
  }
});

router.post('/tasks/bulk/reassign', async (req, res) => {
  try {
    const ids = parseTaskIds(req.body);
    if (!ids.length) throw new Error('Select at least one task.');
    const editor = await db.getEditorById(req.body.editorId);
    if (!editor) throw new Error('Choose an employee to reassign to.');
    const tasks = await loadTasks(ids);
    const n = await bulkReassign(tasks, editor, 'Admin Portal');
    res.redirect('/admin/tasks?ok=' + encodeURIComponent(`Reassigned ${n} task${n === 1 ? '' : 's'} to ${editor.name}.`));
  } catch (e) {
    res.redirect('/admin/tasks?error=' + encodeURIComponent(e.message));
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
    const [awaiting, tasks] = await Promise.all([
      db.getTasksAwaitingReview(100),
      db.getTasksWithDeliverable(100),
    ]);

    const awaitingRows = awaiting.length
      ? awaiting.map(approvalRow).join('')
      : `<tr><td colspan="5" class="empty">Nothing awaiting approval. Submitted work lands here for you to approve or send back.</td></tr>`;

    const rows = tasks.length
      ? tasks.map(changeRow).join('')
      : `<tr><td colspan="6" class="empty">No files submitted yet. When an editor uploads a deliverable on Telegram, it'll appear here.</td></tr>`;

    const body = `
      <div class="card">
        <h2>Awaiting Your Approval (${awaiting.length})</h2>
        <p>Work employees have submitted for review. <strong>Approve</strong> marks it complete and notifies them; <strong>Request Changes</strong> reopens the task with your notes. Both also work from the quick buttons on Telegram.</p>
        <table>
          <thead><tr><th>Work</th><th>Employee</th><th>Reference File</th><th>Submitted</th><th>Action</th></tr></thead>
          <tbody>${awaitingRows}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>All Delivered Files</h2>
        <p style="font-size:0.85rem;color:var(--muted-fg);margin-bottom:16px">
          Every file your editors have delivered. <strong>Request Changes</strong> reopens the task — the editor is notified on Telegram with your notes and the round is tracked as a revision (status shows <span class="badge st-changes">🔁 Changes</span>). The original deadline applied only to the first delivery, so revisions stay open-ended (never overdue) unless you set a fresh <em>Revision deadline</em>. When you're happy, <strong>Approve</strong>.
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
  const { notes, reviewDeadline } = req.body;
  try {
    if (!notes || !notes.trim()) throw new Error('Change notes are required.');
    const task = await db.getTaskById(req.params.id);
    if (!task) throw new Error('Task not found.');
    // Optional deadline for the revision round — omit it and revisions stay open-ended.
    const deadline = reviewDeadline && reviewDeadline.trim() ? parseDeadline(reviewDeadline.trim()) : null;
    await requestChanges(task, notes.trim(), 'Admin Portal', deadline);
    res.redirect('/admin/changes?ok=' + encodeURIComponent(`Change request sent to ${task.editors?.name || 'the editor'} for "${task.project_name}".`));
  } catch (e) {
    res.redirect('/admin/changes?error=' + encodeURIComponent(e.message));
  }
});

router.post('/changes/:id/approve', async (req, res) => {
  try {
    const task = await db.getTaskById(req.params.id);
    if (!task) throw new Error('Task not found.');
    await approveTask(task, 'Admin Portal');
    res.redirect('/admin/changes?ok=' + encodeURIComponent(`Approved "${task.project_name}" — marked Completed.`));
  } catch (e) {
    res.redirect('/admin/changes?error=' + encodeURIComponent(e.message));
  }
});

// Backwards-compatible alias for the old "Mark Done" button URL.
router.post('/changes/:id/done', (req, res) => {
  res.redirect(307, `/admin/changes/${req.params.id}/approve`);
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
            <td style="font-size:0.8rem;color:var(--muted-fg)">${fmtDateTime(s.lastStartedAt)}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="10" class="empty">No employees yet. <a href="/admin/employees">Add one →</a></td></tr>`;

    const body = `
      ${summaryStats}
      <div class="card">
        <h2>Employee Performance</h2>
        <p style="font-size:0.8rem;color:var(--muted-fg);margin-bottom:16px">
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
        <td style="font-size:0.8rem;color:var(--muted-fg)">${fmtDateTime(c.created_at)}</td>
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
      <p style="font-size:0.85rem;color:var(--muted-fg);margin-bottom:16px">
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

