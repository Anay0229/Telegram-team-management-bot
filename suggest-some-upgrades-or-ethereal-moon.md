# Upgrade Plan: Systematic Task Tracking & Noise Reduction

## Context

The bot already has a solid foundation — deadline reminders, escalation alerts, daily digests, admin portal, revision tracking, etc. But as the team grows, the **volume of individual Telegram messages becomes noise**: each status change, each file upload, each reminder fires its own message, and both owners and editors end up scrolling back to find context. The goal is to reduce that noise without losing visibility.

---

## Suggested Upgrades (ordered by impact/effort ratio)

---

### 1. Live Status Message (Edit-in-Place per Editor)

**Problem**: Editors receive separate messages for every status change, nudge, and reminder — cluttering their DMs.

**Solution**: Keep one "current status" message per editor, pinned at the top of the DM, that the bot *edits in-place* rather than sending new messages.

**How it works**:
- On assignment, the bot sends the assignment message and pins it.
- On every status change (started / submitted / revision / approved), the bot edits that pinned message to reflect current state.
- Reminders still get sent as new messages, but the "source of truth" is the pinned one.

**Files to touch**:
- `src/services/assignments.js` — store `pinned_msg_id` per editor-task
- `src/services/telegram.js` — add `editMessage()` wrapper
- `src/db/supabase.js` — add `pinned_msg_id` column to tasks

**Benefit**: Editors always know where to look. Owners see fewer one-off status pings.

---

### 2. Task Reference Codes (TASK-001 style)

**Problem**: Tasks are referenced by project name, which is fuzzy — "video" or "shoot" matches multiple tasks. Causes confusion in `done`, `blocked`, `changes` commands.

**Solution**: Auto-generate a short human-readable code at assignment (e.g., `VID-042`, `GFX-017`). Commands accept either name or code.

**How it works**:
- Code format: 3-letter type prefix + sequential number (or last 3 digits of task ID)
- Editors can type `done VID-042` instead of guessing which "video" task
- All notification messages show the code prominently
- Admin portal shows code in task list and search

**Files to touch**:
- `src/db/supabase.js` — add `task_code` column, generate on `createTask()`
- `src/services/formatters.js` — prepend code to all task title formats
- `src/handlers/editorHandler.js` + `ownerHandler.js` — resolve by code OR name

**Benefit**: Single unambiguous identifier eliminates "which task?" confusion completely.

---

### 3. Batched Notification Digest (replace per-event pings to owner)

**Problem**: Owners get individual messages for every action — submitted, blocked, started — even when multiple happen in minutes.

**Solution**: Buffer owner notifications for 5 minutes, then send one batched message: "3 updates: VID-042 submitted, GFX-017 blocked (waiting on assets), SHT-003 started."

**How it works**:
- In-memory queue per owner (already have `pendingState.js` pattern)
- `setTimeout` 5 min → flush as a single grouped message
- Urgent events (escalation, block) bypass the buffer and fire immediately
- "Always immediate" list is configurable in `src/config.js`

**Files to touch**:
- New `src/services/notificationBuffer.js`
- `src/services/telegram.js` — route owner notifications through buffer
- `src/config.js` — add `notifications.bufferMs` and `immediateEvents` list

**Benefit**: Owner gets 1 message instead of 10 during a busy hour. Critical events still arrive instantly.

---

### 4. Quiet Hours / Notification Preferences per Owner

**Problem**: Escalation alerts fire every 10 minutes — even at midnight.

**Solution**: Add configurable quiet hours (e.g., 11 PM–8 AM) per owner. During quiet hours, non-critical messages are held until morning.

**How it works**:
- `config.js` gains `quietHours: { start: 23, end: 8 }` per owner
- Scheduler checks current hour before sending escalation/digest
- A "held messages" list flushes at the end of quiet hours
- Block alerts always go through (genuinely urgent)

**Files to touch**:
- `src/config.js` — quiet hours config
- `src/jobs/scheduler.js` — wrap all `sendToOwners()` calls with quiet-hour check
- New `src/services/notificationBuffer.js` (same module as #3)

**Benefit**: Owners aren't woken up by 2 AM escalation pings about tasks that won't be resolved until morning anyway.

---

### 5. Kanban View in Admin Portal

**Problem**: The task list table is hard to scan at a glance when there are 10+ active tasks.

**Solution**: Add a `/admin/kanban` page with drag-and-drop columns: Pending → In Progress → In Review → Blocked → Done.

**How it works**:
- Each card shows: task code, client, type, editor avatar/name, deadline, priority badge
- Cards sorted by deadline within each column
- Click card → existing task detail page
- Drag card to new column → calls existing `/admin/tasks/:id` status update endpoint
- Uses [Sortable.js](https://github.com/SortableJS/Sortable) (lightweight, no framework needed)

**Files to touch**:
- New route `GET /admin/kanban` in `src/routes/admin.js`
- New view `src/views/kanban.ejs`
- Existing status-update endpoint already exists — just call it on drag-drop

**Benefit**: Visual overview replaces scanning a table. Blocked and overdue tasks jump out immediately.

---

### 6. "My Tasks" Summary Card (Editor Telegram, not digest)

**Problem**: The daily digest at 8:30 AM is a wall of text. Editors lose it in chat.

**Solution**: Replace (or supplement) the digest with a single formatted card using Telegram's HTML/Markdown that renders like a mini dashboard:

```
📋 YOUR TASKS — Mon 16 Jun
━━━━━━━━━━━━━━━━━━
🔴 VID-042 · Brandx Promo  ← 2h left
🟡 GFX-017 · Logo Refresh  ← tomorrow 3 PM
🟢 SHT-003 · Team Photos   ← 18 Jun 10 AM
━━━━━━━━━━━━━━━━━━
Reply: done VID-042 · blocked VID-042 [reason]
```

**Files to touch**:
- `src/services/formatters.js` — new `editorDashboardCard()` function
- `src/jobs/scheduler.js` — swap `sendEditorDigests()` to use new format

**Benefit**: Scannable in 2 seconds. Editor knows what's urgent without parsing paragraphs.

---

### 7. Snooze / Acknowledge Reminders

**Problem**: Pre-deadline reminders at 24h and 2h are useful, but if an editor is actively working, they're noise.

**Solution**: Add a "Got it 👍" button on reminder messages. Tapping it:
- Suppresses further reminders for that task for X hours (configurable, default 4h)
- Sends owner a small "VID-042 acknowledged by [editor]" ping (optional, configurable)

**Files to touch**:
- `src/services/keyboards.js` — add `acknowledge` callback button
- `src/handlers/callbackHandler.js` — handle `ack:[taskId]`, set `snoozed_until` timestamp
- `src/db/supabase.js` — add `snoozed_until` column
- `src/jobs/scheduler.js` — skip reminders where `snoozed_until > now()`

**Benefit**: Reduces "I know, I know" frustration. Owners get a passive confirmation that editors are on it.

---

### 8. Escalation Cooldown (reduce 10-min spam)

**Problem**: Escalation fires every 10 minutes indefinitely once a task is overdue. That's 6 messages/hour per overdue task.

**Solution**: Escalation tiers — one alert at +2h, one at +6h, one at +12h, then daily. Stop after owner acknowledges (taps a button on the alert).

**How it works**:
- Change `escalated_at` to `escalation_log` (JSON array like `review_log`)
- Each tier fires once, logged with timestamp
- Alert message includes "✅ Mark Seen" button — clears escalation for that task

**Files to touch**:
- `src/db/supabase.js` — `escalation_log` column
- `src/jobs/scheduler.js` — `sendEscalationAlerts()` logic tiered
- `src/handlers/callbackHandler.js` — handle `ack_escalation:[taskId]`

**Benefit**: Owners aren't hammered every 10 minutes. Urgency is preserved via tiers.

---

## Priority Recommendation

| # | Upgrade | Effort | Impact | Do First? |
|---|---------|--------|--------|-----------|
| 2 | Task Reference Codes | Low | High | ✅ Yes |
| 6 | Better Editor Card | Low | High | ✅ Yes |
| 8 | Escalation Cooldown | Low | High | ✅ Yes |
| 3 | Batched Owner Notifications | Medium | High | Yes |
| 7 | Snooze Reminders | Medium | Medium | Maybe |
| 5 | Kanban View | Medium | Medium | Maybe |
| 1 | Live Status Message | High | Medium | Later |
| 4 | Quiet Hours | Low | Medium | Later |

---

## Verification

For each upgrade:
- Start the bot locally (`node src/index.js`)
- Assign a test task and verify the change is reflected (new code, updated card, etc.)
- Trigger a reminder manually via `test reminders` owner command
- Check admin portal at `localhost:3000/admin` reflects new fields
