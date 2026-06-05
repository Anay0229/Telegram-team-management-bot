# Framex Originals WhatsApp Bot

WhatsApp-based team management bot for assigning video projects, tracking editor workload, and sending reminders through WhatsApp Web.

## What the bot does

- Lets the owner create new projects from WhatsApp.
- Suggests editors based on current workload.
- Sends project assignments and Drive links to editors.
- Lets editors mark work as started, completed, or blocked.
- Sends daily digests, deadline reminders, and escalation alerts.
- Lets the owner attach a custom **note** to any assignment, sent to the editor on WhatsApp.
- Provides an **owner admin portal** to see stats, assign work, change task status, and manage editors — everything the owner can do over WhatsApp, in a browser.

## Requirements

- Node.js 18 or newer
- npm
- Google Chrome installed on the machine running the bot
- A Supabase project
- A WhatsApp account that will stay linked to the bot

## Step 1: Install dependencies

Open a terminal in the project folder and run:

```bash
npm install
```

## Step 2: Create the Supabase database

1. Open your Supabase project.
2. Go to **SQL Editor**.
3. Open `src/db/schema.sql` from this project.
4. Copy the full SQL into Supabase.
5. Run it.

This creates the required tables:

- `editors`
- `tasks`

## Step 3: Configure environment variables

Copy `.env.example` to `.env`:

```bash
copy .env.example .env
```

Then open `.env` and update these values:

```env
OWNER_WHATSAPP_NUMBER=+919999999999
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key_here
DRIVE_RAW_FILES=https://drive.google.com/drive/folders/your-raw-files-folder
DRIVE_FINAL_DATA=https://drive.google.com/drive/folders/your-final-data-folder
PORT=3000
NODE_ENV=development
ADMIN_PASSWORD=change-me-to-a-strong-password
```

Use the owner's WhatsApp number in E.164 format, including the `+` and country code.

`ADMIN_PASSWORD` protects the admin portal with a login prompt (any username, this password). If you leave it blank the portal is open to anyone who can reach the server — only do that for local development.

Important: `SUPABASE_SERVICE_KEY` should be the Supabase service role key. Keep it private and do not share or commit the `.env` file.

## Step 4: Start the bot

For normal use:

```bash
npm start
```

For development with automatic restart:

```bash
npm run dev
```

When the bot starts for the first time, it prints a QR code in the terminal.

## Step 5: Link WhatsApp

1. Open WhatsApp on your phone.
2. Go to **Linked Devices**.
3. Tap **Link a device**.
4. Scan the QR code shown in the terminal.
5. Wait until the terminal says the WhatsApp client is ready.

After login, the session is saved locally in `.wwebjs_auth`, so you usually do not need to scan the QR code again.

## Step 6: Use the owner admin portal

With the bot running, open this page in your browser:

```text
http://localhost:3000/admin
```

If `ADMIN_PASSWORD` is set, the browser asks for a login — enter any username and that password.

The portal has four sections:

- **Dashboard** — live stats (active, overdue, blocked, done today, editor count) and an active-work table where you can change any task's status.
- **Assign Work** — assign a new project to an editor, with an optional **note** that is sent to the editor on WhatsApp. The editor count next to each name shows their current workload.
- **Tasks** — every active task, with quick status changes (changing to *blocked* lets you add a reason).
- **Editors** — add editors (name, WhatsApp number with country code, role) and activate/deactivate them.

Everything you do in the portal notifies the relevant editor and all owners on WhatsApp, exactly like the WhatsApp commands. Data is stored in Supabase.

## Step 7: Use the bot on WhatsApp

Send commands from the owner's WhatsApp number configured in `.env`.

### Owner commands

Create a project (the `note:` part is optional and is sent to the editor):

```text
new project: Short Film Grade | post-production | deadline: 10 Jun | note: Use the new brand LUT
```

The bot replies with ranked editor suggestions. Reply with the editor number or name:

```text
1
```

or:

```text
assign to Rahul
```

Other owner commands:

```text
team status
```

```text
Rahul status
```

```text
overdue
```

```text
completed today
```

```text
help
```

### Editor commands

Editors can reply to the bot with:

```text
my tasks
```

```text
started
```

```text
done
```

```text
blocked waiting for client feedback
```

```text
send raw folder
```

```text
send final folder
```

```text
help
```

## Scheduled messages

The bot starts scheduled jobs after WhatsApp is ready:

- Daily digest to owner at 9:00 AM Asia/Kolkata time
- Deadline reminders every hour for tasks due within 24 hours
- Escalation alerts every 30 minutes for tasks still in progress 2+ hours after deadline

Keep the bot process running for scheduled messages to work.

## Health check

Open this URL while the bot is running:

```text
http://localhost:3000/
```

You should see:

```json
{
  "status": "ok",
  "service": "Framex Originals WhatsApp Bot"
}
```

## Troubleshooting

### QR code appears every time

Make sure the `.wwebjs_auth` folder is not deleted. It stores the WhatsApp Web login session.

### Bot does not reply

Check that:

- The terminal says the WhatsApp client is ready.
- The message is not being sent from a WhatsApp group.
- The owner number in `.env` exactly matches the WhatsApp number, including country code.
- Editors are saved with the correct WhatsApp number in the admin panel.

### Supabase errors

Check that:

- `SUPABASE_URL` is correct.
- `SUPABASE_SERVICE_KEY` is the service role key.
- `src/db/schema.sql` has been run successfully.
- The `editors` and `tasks` tables exist.

### Chrome or browser launch errors

Install Google Chrome and restart the bot. The bot uses the locally installed Chrome browser for WhatsApp Web.

### Port already in use

Change the `PORT` value in `.env`, then restart the bot.

Example:

```env
PORT=3001
```

Then open:

```text
http://localhost:3001/admin
```

## Project structure

```text
src/index.js                 Main bot and server entry point
src/config.js                Environment configuration
src/db/schema.sql            Supabase database schema
src/db/supabase.js           Supabase database functions
src/handlers/ownerHandler.js Owner WhatsApp commands
src/handlers/editorHandler.js Editor WhatsApp commands
src/jobs/scheduler.js        Daily digest, reminders, and escalations
src/routes/admin.js          Owner admin portal (dashboard, assign, tasks, editors)
src/services/assignments.js  Shared assign + status-change logic (WhatsApp and portal)
src/services/whatsapp.js     WhatsApp Web client setup
```

## Stop the bot

Press `Ctrl + C` in the terminal where the bot is running.
