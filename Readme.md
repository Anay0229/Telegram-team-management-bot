# Framex Originals Telegram Bot

Telegram-based team management bot for assigning creative work (edit, shoot, graphic design, data sorting), load-balancing it across employees, tracking each task through an approval and revision lifecycle, and sending reminders and escalations. Backed by Supabase.

## What the bot does

- Lets owners create new projects from Telegram and suggests the least-loaded, role-compatible employee for the work.
- Sends assignments (with the Drive link and an optional note) to the chosen employee, with quick **Started / Done / Blocked** buttons.
- Runs an approval loop: an employee's **Done** submits the work for review; owners **Approve** it or **Request Changes** (with optional reference files), which reopens it as a new revision round.
- Lets employees submit deliverable files, which are forwarded to owners; owners can request changes simply by replying to the forwarded file.
- Sends per-employee morning digests, an owner daily digest, pre-deadline reminders, at-deadline reminders, and overdue escalations.
- Tracks per-task lifecycle history and per-employee performance stats.
- Provides an **owner admin portal** to see stats, assign work, change task status, run bulk actions, manage employees and clients, and review performance — everything owners can do over Telegram, in a browser.

## Requirements

- Node.js 18 or newer
- npm
- A Supabase project
- A Telegram bot token (create one via [@BotFather](https://t.me/BotFather))

## Step 1: Install dependencies

Open a terminal in the project folder and run:

```bash
npm install
```

## Step 2: Create the Supabase database

1. Open your Supabase project.
2. Go to **SQL Editor**.
3. Open `src/db/schema.sql` from this project, copy the full SQL into Supabase, and run it.

This creates the `clients`, `editors`, and `tasks` tables.

If you are upgrading an **existing** database, run `src/db/migrations.sql` instead (or in addition) — it is an idempotent, run-once script that adds any newer columns and constraints. Until it runs, the bot keeps working but newer features (the "submitted for review" status, lifecycle history, pre-deadline reminders, priority, on-leave) degrade gracefully.

## Step 3: Configure environment variables

Create a `.env` file in the project root with these values:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token-from-BotFather
OWNER_TELEGRAM_IDS=111111111,222222222
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key_here
DRIVE_RAW_FILES=https://drive.google.com/drive/folders/your-raw-files-folder
DRIVE_FINAL_DATA=https://drive.google.com/drive/folders/your-final-data-folder
GROUP_CHAT_ID=
PORT=3000
NODE_ENV=development
ADMIN_PASSWORD=change-me-to-a-strong-password
```

- `TELEGRAM_BOT_TOKEN` — the token BotFather gives you.
- `OWNER_TELEGRAM_IDS` — comma-separated numeric Telegram **user IDs** of the people who can assign and manage work. To find an ID, message [@userinfobot](https://t.me/userinfobot), or message your bot and read the `[MSG] From: <id>` line in the server logs.
- `GROUP_CHAT_ID` — *optional*. Set it to a group chat's ID to enable **group mode** (see below). Leave blank to DM each owner individually.
- `ADMIN_PASSWORD` — protects the admin portal with a login prompt (any username, this password). If left blank the portal is open to anyone who can reach the server — only do that for local development.

Important: `SUPABASE_SERVICE_KEY` must be the Supabase service role key. Keep it private and never commit `.env`.

## Step 4: Start the bot

For normal use:

```bash
npm start
```

For development with automatic restart:

```bash
npm run dev
```

On startup the bot connects to Telegram (retrying with backoff if the network is down), starts the scheduled jobs, and logs `✅ Telegram bot @yourbot is running!`. There is no QR code — Telegram bots authenticate with the token alone.

The same process also serves the admin portal on `PORT`.

## Step 5: Use the owner admin portal

With the bot running, open:

```text
http://localhost:3000/admin
```

If `ADMIN_PASSWORD` is set, the browser asks for a login — enter any username and that password.

The portal sections:

- **Dashboard** — live stats and an active-work table where you can change any task's status.
- **Assign Work** — assign a new project to an employee, with an optional note sent to them on Telegram. The active-task count next to each name shows their current workload.
- **Tasks** — every active task, with per-row status changes and delete, plus **bulk** complete / set-deadline / reassign.
- **Kanban** — a drag-and-drop board with a column per status (Pending → In Progress → In Review → Blocked). Drag a card to change its status; click a card to open the task.
- **Changes** — the approval/review queue: approve submitted work or request changes.
- **Employees** — add employees (name, Telegram ID, roles) and activate/deactivate or mark on-leave.
- **Clients** — add and activate/deactivate clients.
- **Performance** — per-employee stats, with CSV export.

Everything done in the portal notifies the relevant employee and all owners on Telegram, exactly like the Telegram commands. Data is stored in Supabase.

## Group mode (optional)

If `GROUP_CHAT_ID` is set, the bot posts all owner-facing updates to that one shared group instead of DMing each owner. In the group, owners issue commands by **@mentioning the bot**, **replying to one of its messages**, or continuing an in-progress flow. To find a group's ID, add the bot to the group, send any message, and read the `[GROUP] Message in unconfigured group <id>` line in the logs.

## Step 6: Use the bot on Telegram

Owner commands must come from a Telegram account whose ID is in `OWNER_TELEGRAM_IDS`.

### Owner commands

Create a project — format: `new project: [client] | [main work] | [type] | deadline: [date] | priority: [optional] | note: [optional]`. Use `-` for the client to skip it.

```text
new project: Acme Brand | Brand Reel | edit | deadline: 10 Jun | priority: high | note: Use the new brand LUT
```

Types: **edit · shoot · graphic designing · data sorting**. Priority: **low · normal · high · urgent** (defaults to normal).

The bot replies with ranked employee suggestions plus tap-to-assign buttons. Reply with the number, the name, or tap a button:

```text
1
```

```text
assign to Rahul
```

Other owner commands:

```text
clients                        list available clients
team status                    all active tasks
Rahul status                   one employee's active tasks
overdue                        overdue tasks
completed today                tasks completed today
mark Brand Reel done           change a task's status (done | in progress | blocked [reason] | pending)
changes Brand Reel | fix intro and redo color grade    request a revision (or reply to the employee's file)
reassign Brand Reel to Priya   move a task to another employee
nudge Brand Reel               re-ping the assigned employee (also: nudge Rahul for all their work)
leave Rahul                    mark an employee on-leave (skipped when assigning)
back Rahul                     mark them available again
test reminders                 run the deadline/escalation checks on demand
help                           show the command menu
```

Tasks can also be referenced by their short code (e.g. `EDT-A3F2`, shown in notifications) in `mark`, `changes`, `reassign`, and `nudge` commands.

### Employee commands

Employees reply to the bot with:

```text
my tasks                       list your active tasks
started                        mark in progress
done                           submit for owner review
blocked waiting for client feedback     mark blocked with a reason
send raw folder                get the raw files Drive link
send final folder              get the final data Drive link
unavailable / available        set your own on-leave status (also: leave / back)
help                           show the command menu
```

When an employee has more than one task, target a specific one by **replying to that task's assignment message**, by its list number (`done 2`), or by its code (`done EDT-A3F2`). Sending a **file** forwards it to the owners; captioning that file `done` both submits the file and sends the task for review.

## Scheduled messages

The scheduler starts with the bot (timezone Asia/Kolkata):

- Per-employee morning digest at 8:30 AM
- Owner daily digest at 9:00 AM
- Pre-deadline reminders every 15 minutes (heads-up 24h and 2h before a deadline). Each carries a **Got it 👍** button — tapping it pauses further pre-deadline reminders for that task for a few hours.
- At-deadline reminders every minute (fires once, the moment a deadline is reached)
- Escalation alerts to owners every 10 minutes for tasks still in progress past their deadline. Alerts are **tiered** (+2h, +6h, +12h, then once a day) and each has a **Mark Seen** button that stops further alerts for that task.

**Quiet hours**: between 11 PM and 8 AM (Asia/Kolkata) owner escalation alerts are held and delivered when the window ends, so overnight overdue tasks don't wake anyone. Adjust or disable via `config.quietHours` in `src/config.js`.

Keep the bot process running for scheduled messages to work. Owners can also trigger the deadline checks on demand with `test reminders`.

## Health check

While the bot is running, open `http://localhost:3000/`. You should see:

```json
{ "status": "ok", "service": "Framex Originals Telegram Bot" }
```

## Troubleshooting

### Bot does not reply

- Check the terminal shows `✅ Telegram bot @yourbot is running!`.
- Owner commands only work from accounts listed in `OWNER_TELEGRAM_IDS`. Employees must exist in the `editors` table with the correct numeric Telegram ID.
- In a private chat, message the bot and confirm an `[MSG] From: <id>` line appears in the logs — that's the ID to add.

### `Invalid TELEGRAM_BOT_TOKEN` on startup

The token is wrong or revoked. Re-copy it from BotFather into `.env` and restart.

### Telegram 409 / polling conflict

Another instance of the bot is already polling with the same token. Stop the other process — only one instance can run per token.

### Supabase errors / features silently not working

- Confirm `SUPABASE_URL` and the service-role `SUPABASE_SERVICE_KEY` are correct.
- Confirm `src/db/schema.sql` ran and the `clients`, `editors`, `tasks` tables exist.
- If "done" doesn't move tasks to a review state, lifecycle history shows "Not recorded", priority/on-leave/pre-deadline reminders don't work, escalation isn't tiered, or the reminder "Got it 👍" snooze does nothing, run `src/db/migrations.sql` — those features require columns that older databases lack.

### Port already in use

Change `PORT` in `.env` and restart, then open `http://localhost:<new-port>/admin`.

## Project structure

```text
src/index.js                  Telegram event wiring + Express server entry point
src/config.js                 Environment configuration, owners, load-score weights
src/db/schema.sql             Supabase database schema (full create)
src/db/migrations.sql         Idempotent migration for existing databases
src/db/supabase.js            Supabase data-access functions
src/handlers/messageHandler.js  Inbound routing (owner vs employee vs unknown)
src/handlers/ownerHandler.js    Owner text commands
src/handlers/editorHandler.js   Employee text commands + file uploads
src/handlers/callbackHandler.js Inline-button (callback_query) handling
src/handlers/pendingState.js    In-memory multi-step conversation state
src/jobs/scheduler.js         Digests, reminders, escalations (node-cron)
src/routes/admin.js           Owner admin portal
src/services/assignments.js   Shared assign/status/revision/approval logic (Telegram + portal)
src/services/telegram.js      Telegram client setup and send helpers
src/services/loadBalancer.js  Ranks employees by workload + role compatibility
src/services/keyboards.js     Inline keyboards + callback-data scheme
src/services/formatters.js    Message formatting + task codes
src/public/admin.css          Admin portal styles
```

## Stop the bot

Press `Ctrl + C` in the terminal where the bot is running.
