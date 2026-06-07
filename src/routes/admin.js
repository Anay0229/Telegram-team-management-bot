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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    /* ── Design tokens: Bold Typography ───────────────────────────────────── */
    :root {
      --bg: #0A0A0A; --fg: #FAFAFA; --muted: #1A1A1A; --muted-fg: #737373;
      --accent: #FF3D00; --accent-fg: #0A0A0A; --border: #262626; --border-hover: #3A3A3A;
      --input: #1A1A1A; --card: #0F0F0F;
      --good: #34D399; --warn: #FBBF24;
      --font-sans: "Inter Tight", "Inter", system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
      --ease: cubic-bezier(0.25, 0, 0, 1);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      font-family: var(--font-sans); background: var(--bg); color: var(--fg);
      min-height: 100vh; line-height: 1.6; letter-spacing: -0.01em;
      -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    }
    /* Subtle fractal-noise grain over the whole page */
    body::after {
      content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 100; opacity: .025;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    }
    a { color: inherit; }
    ::selection { background: var(--accent); color: var(--accent-fg); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* ── Masthead ──────────────────────────────────────────────────────────── */
    header {
      position: sticky; top: 0; z-index: 50;
      background: rgba(10,10,10,.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      padding: 18px clamp(24px, 5vw, 64px);
      display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
    }
    .brand { font-size: 1rem; font-weight: 800; letter-spacing: -0.03em; text-transform: uppercase; }
    .brand .dot { color: var(--accent); }
    .owner-tag {
      font-family: var(--font-mono); font-size: .62rem; font-weight: 500;
      text-transform: uppercase; letter-spacing: .2em; color: var(--accent);
      border: 1px solid var(--border); padding: 3px 8px;
    }
    nav { display: flex; gap: 4px 18px; margin-left: auto; flex-wrap: wrap; }
    nav a {
      position: relative; text-decoration: none; color: var(--muted-fg);
      font-family: var(--font-mono); font-size: .7rem; font-weight: 500;
      text-transform: uppercase; letter-spacing: .12em; padding: 6px 0;
      transition: color .15s var(--ease);
    }
    nav a::after {
      content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
      background: var(--accent); transform: scaleX(0); transform-origin: left;
      transition: transform .15s var(--ease);
    }
    nav a:hover { color: var(--fg); }
    nav a:hover::after, nav a.active::after { transform: scaleX(1); }
    nav a.active { color: var(--fg); }

    /* ── Layout ────────────────────────────────────────────────────────────── */
    main { max-width: 1200px; margin: 0 auto; padding: clamp(44px, 7vw, 88px) clamp(24px, 5vw, 64px) 120px; }
    .page-head { margin-bottom: clamp(32px, 5vw, 56px); }
    .eyebrow {
      font-family: var(--font-mono); font-size: .7rem; font-weight: 500;
      text-transform: uppercase; letter-spacing: .2em; color: var(--muted-fg);
      display: flex; align-items: center; gap: 12px; margin-bottom: 20px;
    }
    .eyebrow::before { content: ''; width: 36px; height: 2px; background: var(--accent); }
    .page-title { font-size: clamp(2.75rem, 8vw, 6rem); font-weight: 800; line-height: .92; letter-spacing: -0.05em; }

    /* ── Cards / sections ──────────────────────────────────────────────────── */
    .card { background: var(--card); border: 1px solid var(--border); padding: clamp(24px, 4vw, 40px); margin-bottom: 24px; overflow-x: auto; }
    .card h2 {
      position: relative; padding-top: 18px; margin-bottom: 26px;
      font-size: 1.5rem; font-weight: 700; letter-spacing: -0.03em; line-height: 1.15;
    }
    .card h2::before { content: ''; position: absolute; top: 0; left: 0; width: 40px; height: 3px; background: var(--accent); }
    .section-link {
      float: right; font-family: var(--font-mono); font-size: .72rem; font-weight: 500;
      text-transform: uppercase; letter-spacing: .1em; color: var(--accent); text-decoration: none; padding-top: 6px;
    }
    .section-link:hover { text-decoration: underline; text-underline-offset: 3px; }
    .card > p { color: var(--muted-fg); font-size: .9rem; line-height: 1.7; margin-bottom: 20px; max-width: 70ch; }
    .card > p strong { color: var(--fg); font-weight: 600; }

    /* ── Flash messages ────────────────────────────────────────────────────── */
    .flash {
      font-family: var(--font-mono); font-size: .8rem; padding: 14px 18px; margin-bottom: 24px;
      border: 1px solid var(--border); border-left-width: 3px; letter-spacing: .01em; line-height: 1.5;
    }
    .flash.ok  { border-left-color: var(--good); color: var(--good); }
    .flash.err { border-left-color: var(--accent); color: var(--accent); }

    /* ── Stat strip ────────────────────────────────────────────────────────── */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--border); border: 1px solid var(--border); margin-bottom: 24px; }
    .stat { background: var(--bg); padding: 28px 24px; position: relative; }
    .stat::before { content: ''; position: absolute; top: 0; left: 24px; width: 24px; height: 3px; background: var(--accent); opacity: 0; transition: opacity .15s var(--ease); }
    .stat:hover::before { opacity: 1; }
    .stat .num { font-size: clamp(2.25rem, 4vw, 3rem); font-weight: 800; line-height: 1; letter-spacing: -0.04em; }
    .stat .lbl { font-family: var(--font-mono); font-size: .66rem; color: var(--muted-fg); margin-top: 14px; text-transform: uppercase; letter-spacing: .16em; font-weight: 500; }
    .stat.warn .num  { color: var(--accent); }
    .stat.block .num { color: var(--warn); }
    .stat.good .num  { color: var(--good); }

    /* ── Forms ─────────────────────────────────────────────────────────────── */
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    label { display: flex; flex-direction: column; gap: 9px; font-family: var(--font-mono); font-size: .7rem; font-weight: 500; text-transform: uppercase; letter-spacing: .12em; color: var(--muted-fg); }
    label.full { grid-column: 1 / -1; }
    input, select, textarea {
      font-family: var(--font-sans); font-size: 1rem; letter-spacing: -0.01em; text-transform: none;
      background: var(--input); color: var(--fg); border: 1px solid var(--border); border-radius: 0;
      padding: 0 16px; height: 52px; outline: none; transition: border-color .15s var(--ease); width: 100%;
    }
    textarea { padding: 14px 16px; height: auto; min-height: 96px; resize: vertical; line-height: 1.6; }
    select {
      appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 42px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%23737373' stroke-width='1.5'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 16px center;
    }
    input::placeholder, textarea::placeholder { color: var(--muted-fg); }
    input:focus, select:focus, textarea:focus { border-color: var(--accent); }
    input:disabled, select:disabled, textarea:disabled { opacity: .5; cursor: not-allowed; }
    .hint { font-family: var(--font-sans); font-size: .78rem; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--muted-fg); line-height: 1.5; }
    .submit-row { margin-top: 30px; }

    /* ── Buttons ───────────────────────────────────────────────────────────── */
    /* Primary: outline that inverts on hover */
    button {
      font-family: var(--font-mono); font-weight: 600; font-size: .72rem; text-transform: uppercase; letter-spacing: .14em;
      cursor: pointer; border-radius: 0; border: 1px solid var(--fg); background: transparent; color: var(--fg);
      padding: 0 28px; height: 48px; display: inline-flex; align-items: center; justify-content: center; gap: 10px;
      white-space: nowrap; transition: background .15s var(--ease), color .15s var(--ease), transform .1s var(--ease);
    }
    button:hover { background: var(--fg); color: var(--bg); }
    button:active { transform: translateY(1px); }
    button:disabled { pointer-events: none; opacity: .5; }
    /* Ghost: accent text with an animated underline */
    button.ghost {
      border: none; background: transparent; color: var(--accent); padding: 0; height: auto;
      position: relative; letter-spacing: .1em;
    }
    button.ghost::after {
      content: ''; position: absolute; left: 0; bottom: -3px; width: 100%; height: 2px; background: var(--accent);
      transform: scaleX(0); transform-origin: left; transition: transform .15s var(--ease);
    }
    button.ghost:hover { background: transparent; color: var(--accent); }
    button.ghost:hover::after { transform: scaleX(1); }
    /* Danger: accent outline that fills */
    button.danger { border-color: var(--accent); color: var(--accent); background: transparent; height: auto; padding: 9px 16px; }
    button.danger:hover { background: var(--accent); color: var(--accent-fg); }

    form.inline-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    form.inline-form select, form.inline-form input { height: 40px; font-size: .85rem; padding: 0 12px; width: auto; }

    /* ── Tables ────────────────────────────────────────────────────────────── */
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    thead tr { border-bottom: 1px solid var(--border); }
    th { text-align: left; padding: 0 14px 14px; font-family: var(--font-mono); font-size: .64rem; text-transform: uppercase; letter-spacing: .16em; color: var(--muted-fg); font-weight: 500; white-space: nowrap; }
    td { padding: 18px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
    tbody tr { transition: background .15s var(--ease); }
    tbody tr:hover { background: var(--muted); }
    tbody tr:last-child td { border-bottom: none; }
    td strong { font-weight: 700; letter-spacing: -0.01em; }

    /* ── Badges (sharp, mono, restrained colour) ───────────────────────────── */
    .badge {
      display: inline-block; font-family: var(--font-mono); padding: 3px 9px; border: 1px solid var(--border);
      background: transparent; color: var(--muted-fg); font-size: .64rem; font-weight: 500;
      text-transform: uppercase; letter-spacing: .1em; white-space: nowrap; line-height: 1.5;
    }
    /* Type / role badges stay neutral — distinguished by label, not colour */
    .badge.type-edit, .badge.type-shoot, .badge.type-gd, .badge.type-ds,
    .badge.pre, .badge.post, .badge.both { color: var(--fg); }
    .badge.no-dl { color: var(--muted-fg); }
    /* Semantic states: accent = attention, green = good, amber = pending */
    .badge.active, .badge.st-done, .badge.on-time { color: var(--good); border-color: var(--good); }
    .badge.inactive, .badge.late, .badge.st-blocked, .badge.st-changes { color: var(--accent); border-color: var(--accent); }
    .badge.st-pending  { color: var(--warn); border-color: var(--warn); }
    .badge.st-progress { color: var(--fg); border-color: var(--border-hover); }

    /* ── Misc text helpers ─────────────────────────────────────────────────── */
    .note { font-family: var(--font-sans); font-size: .78rem; color: var(--muted-fg); margin-top: 6px; line-height: 1.5; }
    .client-tag { font-family: var(--font-mono); font-size: .66rem; text-transform: uppercase; letter-spacing: .14em; color: var(--accent); font-weight: 500; margin-bottom: 6px; }
    .overdue-flag { font-family: var(--font-mono); color: var(--accent); font-weight: 600; font-size: .64rem; text-transform: uppercase; letter-spacing: .12em; margin-top: 6px; }
    .empty { text-align: center; color: var(--muted-fg); padding: 44px 0; font-family: var(--font-mono); font-size: .8rem; text-transform: uppercase; letter-spacing: .1em; }
    .empty a { color: var(--accent); }
    mono, .mono { font-family: var(--font-mono); font-size: .78rem; }
    code { font-family: var(--font-mono); font-size: .85em; background: var(--muted); padding: 2px 6px; color: var(--accent); }
    .rate-good { color: var(--good); font-weight: 600; font-family: var(--font-mono); }
    .rate-warn { color: var(--warn); font-weight: 600; font-family: var(--font-mono); }
    .rate-bad  { color: var(--accent); font-weight: 600; font-family: var(--font-mono); }

    /* Role checkboxes */
    .role-checks { display: flex; gap: 20px; flex-wrap: wrap; padding: 12px 0 4px; }
    .role-checks label { flex-direction: row; align-items: center; gap: 10px; font-family: var(--font-sans); text-transform: none; letter-spacing: 0; font-size: .9rem; font-weight: 400; color: var(--fg); cursor: pointer; }
    .role-checks input[type=checkbox] { width: 18px; height: 18px; border: 1px solid var(--border); border-radius: 0; padding: 0; cursor: pointer; accent-color: var(--accent); }

    /* Changes tab */
    .changes-form { display: flex; flex-direction: column; gap: 8px; min-width: 220px; }
    .changes-form textarea { min-height: 56px; font-size: .85rem; }
    .changes-form button { align-self: flex-start; }

    @media (max-width: 640px) {
      .grid { grid-template-columns: 1fr; }
      nav { width: 100%; margin-left: 0; gap: 4px 16px; }
      header { gap: 14px; }
    }
  </style>
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
        <p style="font-size:0.85rem;color:var(--muted-fg);margin-bottom:16px">
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
