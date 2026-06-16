# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram team-management bot for "Framex Originals" — a video/creative studio. Owners assign creative work (edit / shoot / graphic design / data sorting) to employees over Telegram; the bot load-balances assignments, tracks each task through an approval + revision lifecycle, fires deadline reminders/escalations, and exposes a browser admin portal that mirrors every owner action. Backed by Supabase (Postgres). Node 18+.

> Note: `Readme.md` is **stale** — it describes an older WhatsApp version (whatsapp-web.js, QR login, `OWNER_WHATSAPP_NUMBER`). The actual code is 100% Telegram (`node-telegram-bot-api`, long polling, `TELEGRAM_BOT_TOKEN`). Trust the code over the README.

## Commands

- `npm start` — run the bot (`node src/index.js`).
- `npm run dev` — run with nodemon (auto-restart on change).
- No tests, no linter, no build step exist in this repo.

There is **only one process**: it both long-polls Telegram and serves the Express admin app on `PORT` (default 3000). Important consequence (see memory `admin-import-starts-bot`): requiring `src/routes/admin.js` pulls in `services/telegram.js`, which constructs the bot — so you can't boot the admin/Express side in isolation without the Telegram client coming along. Running a second instance against the same bot token causes Telegram 409 polling conflicts.

## Configuration (`.env`)

Required: `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_IDS` (comma-separated numeric Telegram user IDs — these are the "owners"/managers), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service-role key).
Optional: `GROUP_CHAT_ID` (enables group mode, see below), `DRIVE_RAW_FILES` / `DRIVE_FINAL_DATA` (Google Drive folder links sent to editors), `ADMIN_PASSWORD` (HTTP Basic auth on the portal — **portal is fully open if unset**), `PORT`, `NODE_ENV`.

`src/config.js` centralizes all of this plus `config.isOwner(id)`, `config.isGroup(id)`, load-score weights, and pre-deadline reminder thresholds (`[24, 2]` hours).

## Database & the "graceful degradation" pattern

Schema lives in `src/db/schema.sql` (full create). `src/db/migrations.sql` is the consolidated, idempotent ALTER script to run **by hand** in the Supabase SQL editor on an existing DB.

The codebase is built so that **newer columns are optional at runtime**: many `db/supabase.js` writes are wrapped in try/catch and callers log a warning + fall back instead of crashing when a column/constraint hasn't been migrated yet. This is deliberate. The catch: until the migration runs, features silently no-op. The key migrations and their failure modes are tracked in memory:
- `approval-status-migration` — without the widened `tasks_status_check`, "done" can't set `submitted_for_review` and falls back to `in_progress` (the "done deleted my task" symptom). See `submitForReview` in `services/assignments.js`.
- `work-record-history-migration` — `initial_deadline` / `first_submitted_at` / `review_log` missing → history shows "Not recorded".
- `workflow-features-migration` — `reminders_sent` / `escalated_at` / `priority` / editors.`available` missing → pre-deadline reminders, persistent escalation dedup, priority, and on-leave all degrade.
- `tiered-escalation-snooze-migration` — `escalation_log` / `snoozed_until` missing → escalation falls back to the legacy single-shot path (`legacyEscalationAlerts`) and the reminder "Got it 👍" snooze is a no-op.

When adding a column that older deployments won't have, follow the existing pattern: best-effort write, warn-and-continue on error, and add it to `migrations.sql`.

Three tables: `clients` (pre-made client names), `editors` (employees — note: code/UI say "employee", DB table and joins say `editors`/`editor`; `role` is a `text[]`), `tasks`. Task status flow: `pending → in_progress → submitted_for_review → completed`, with `blocked` as a side state and a revision loop that reopens `completed`/submitted work back to `in_progress`.

## Architecture / request flow

Everything funnels through `src/index.js`, which wires Telegram events and the Express app.

**Inbound message routing** (`handlers/messageHandler.js`): every message/file is dispatched by sender identity — owner (`config.isOwner`) → `ownerHandler`, else registered editor (`db.getEditorByTelegramId`) → `editorHandler`, else "you're not registered". Two parallel entry points: `handleIncomingMessage` (text) and `handleIncomingFile` (media).

**`senderId` vs `chatId`**: a critical distinction. `senderId` is who sent it (used for auth); `chatId` is where to reply and where multi-step conversation state is keyed. They're identical in a private DM but diverge in **group mode**. Always key reply/pending state by `chatId`.

**Group mode** (`GROUP_CHAT_ID` set): instead of DMing each owner, the bot posts all owner-facing updates to one shared group and owners issue commands by @mentioning the bot (or replying to its messages, or mid-flow). `index.js` gates group messages on `botMentioned || isReplyToBot || hasPendingForChat` and strips the @mention before parsing. `services/telegram.js` `sendToOwners`/`sendFileToOwners` send once to the group vs. looping per-owner DM.

**Two ways to do everything — buttons and text are interchangeable:**
- Inline buttons → `handlers/callbackHandler.js`. Callback data is a compact `verb:id` scheme defined in `services/keyboards.js` (`st`/`dn`/`bl`/`ap`/`ch`/`pa`/`no`), kept under Telegram's 64-byte limit.
- Typed commands → parsed in `ownerHandler.js` / `editorHandler.js`.

**Multi-step flows** use in-memory maps in `handlers/pendingState.js` (`pendingAssignments`, `pendingBlockReason`, `pendingChangeNotes`) — process-local and ephemeral by design (lost on restart, harmless). A button tap stashes state, the user's next message completes it. `pendingAssignments`/`pendingChangeNotes` are keyed by `chatId` (group-aware); `pendingBlockReason` by editor's DM id.

**`services/assignments.js` is the shared action layer** — used by BOTH the Telegram handlers and the admin routes, so every owner action behaves identically in chat and in the browser. If you change assignment/status/revision/approval logic, change it here, not in a handler. Each action notifies the affected editor and posts an owner summary (with a `source` tag like "Telegram (button)" / "Admin portal").

**Task identification** (`services/formatters.js`): tasks get a stable human code like `EDT-A3F2` (type prefix + first hex of UUID) — no DB column needed. `looksLikeTaskCode` / `matchTaskByCode` / `taskCode` let owners and editors target a task unambiguously ("done EDT-A3F2"). Editors can also target tasks by replying to the original assignment message (matched via `tasks.assignment_msg_id`) or by list number. `taskTitle` renders "Client — MainWork".

**Load balancer** (`services/loadBalancer.js`): ranks editors for a new task by a load score (active×10 + due-within-48h×5 + blocked×3, ties broken by all-time total), filtered to role-compatible + non-on-leave editors. Lower score = recommended first.

**Deliverable/review flow**: editor sends a file (optionally captioned "done") → forwarded to owners with Approve / Request Changes buttons → owner approves (→ completed) or requests changes (reopens to `in_progress`, bumps `revision_count`, can attach reference files). Owners can request changes by **replying to the forwarded file** (matched via `tasks.deliverable_owner_msgs`, a `{ownerChatId: messageId}` jsonb map).

**Scheduler** (`jobs/scheduler.js`, `node-cron`, tz `Asia/Kolkata`): editor digests 08:30, owner daily digest 09:00, pre-deadline reminders every 15 min, at-deadline reminders every minute (dedup via `deadline_notified_at`), escalations every 10 min. The owner "test reminders" / "run reminders" command invokes these on demand.

- **Pre-deadline reminders** carry a "Got it 👍" button (`kb.reminderButtons`, callback `sn:`); tapping it sets `tasks.snoozed_until` so further pre-deadline reminders for that task are suppressed for `config.reminders.snoozeHours`.
- **Escalation is tiered** (`config.escalation`): once a task is overdue and still `in_progress`, alerts fire at +2h / +6h / +12h, then at most once per 24h, each logged once in `tasks.escalation_log`. Each alert has a "Mark Seen" button (callback `ae:`) that acknowledges it and stops further tiers. If `escalation_log` isn't migrated, `getInProgressOverdueTasks()` throws and the scheduler falls back to `legacyEscalationAlerts()` (the old single-shot `escalated_at` / in-memory `Set` behavior).
- **Quiet hours** (`config.quietHours` / `config.isQuietHour()`, 23:00–08:00 Asia/Kolkata) gate only owner escalation alerts: alerts coming due in the window are held in an in-memory queue and flushed on the first escalation run after it ends. The tier is logged when held, so a restart mid-window simply drops the held copy rather than re-firing.

**Admin portal** (`src/routes/admin.js`, mounted at `/admin`): server-rendered HTML (no framework; `esc()` for escaping, styles in `src/public/admin.css`). HTTP Basic auth via `ADMIN_PASSWORD` with `crypto.timingSafeEqual`. Covers dashboard, per-task detail/lifecycle, assign, task list + bulk actions (complete/deadline/reassign), a drag-and-drop **Kanban** board (`GET /admin/kanban`; columns = statuses, drag = a status update via the existing `POST /admin/tasks/:id/status`; uses Sortable.js from a CDN, no build step), the changes/approval queue, employees, performance (+ CSV export), and clients. `/admin/test/seed-history` and `/admin/test/cleanup` seed/remove demo data. All mutating routes call into `services/assignments.js`.

## Conventions

- All Telegram replies use Markdown; `services/telegram.js` `sendMessage`/`sendFile` auto-retry as plain text when user-supplied content breaks Markdown parsing. Don't hand-build `bot.sendMessage` calls — go through these wrappers so the fallback and owner-fan-out behavior is preserved.
- Task "type" has canonical values `edit` / `shoot` / `graphic_designing` / `data_sorting` plus legacy `pre-production`/`post-production` kept only for display. `ownerHandler.TYPE_ALIASES` maps user words to canonical types.
- The process is resilient by design for running on a low-power always-on host (e.g. a phone): exponential-backoff reconnect on polling failure (`connectBot`), `compression({level:4})`, long static-asset cache. Keep that constraint in mind — avoid heavy CPU work in the hot path.
