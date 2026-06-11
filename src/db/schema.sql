-- Run this in your Supabase SQL editor to create the schema.

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ── Clients ───────────────────────────────────────────────────────────────────
-- Pre-made high-level clients/projects selected from a dropdown when assigning work.

create table if not exists clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists clients_active_idx on clients(active);

-- ── Employees ─────────────────────────────────────────────────────────────────

create table if not exists editors (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  telegram_id text not null unique,  -- Telegram chat ID (numeric, stored as text)
  role        text[] not null default '{}',  -- array: ['editor','shoot','graphic_designer','data_sorting']
  active      boolean not null default true,  -- team membership (false = removed)
  available   boolean not null default true,  -- on-leave flag; false = skipped by the load balancer
  created_at  timestamptz not null default now()
);

-- ── Tasks ─────────────────────────────────────────────────────────────────────

create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid references clients(id) on delete set null,
  project_name  text not null,   -- "main work" / subtask description typed by the owner
  type          text not null check (type in ('edit', 'shoot', 'graphic_designing', 'data_sorting')),
  assigned_to   uuid not null references editors(id) on delete restrict,
  status        text not null default 'pending'
                  check (status in ('pending', 'in_progress', 'blocked', 'submitted_for_review', 'completed')),
  priority      text not null default 'normal'
                  check (priority in ('low', 'normal', 'high', 'urgent')),
  deadline      timestamptz,
  drive_link    text,
  blocked_reason text,
  note          text,                    -- optional note from management, sent to the employee on assignment
  assignment_msg_id text,                -- Telegram message_id for reply-based task matching
  deliverable_file_id   text,            -- Telegram file_id of the last file the editor submitted
  deliverable_file_type text,            -- document | photo | video | audio | voice | animation | video_note
  deliverable_file_name text,            -- original file name (when Telegram provides one)
  deliverable_uploaded_at timestamptz,   -- when the deliverable file was received
  deliverable_owner_msgs jsonb,          -- { "<ownerChatId>": <forwarded message_id> } for reply-to-file change requests
  revision_count int not null default 0, -- how many change-request rounds this task has had
  revision_notes text,                   -- latest change request from the owner/client
  revision_requested_at timestamptz,     -- when the latest changes were requested
  initial_deadline timestamptz,          -- the ORIGINAL deadline, set once at assignment, never overwritten
  first_submitted_at timestamptz,        -- when the task first entered submitted_for_review (1st delivery)
  review_log jsonb not null default '[]'::jsonb, -- one entry per delivery round (see shape below)
  started_at    timestamptz,             -- set on first transition to in_progress
  deadline_notified_at timestamptz,      -- last past-deadline nudge timestamp
  reminders_sent jsonb not null default '[]'::jsonb, -- hour-thresholds already pre-warned for the current deadline, e.g. [24, 2]
  escalated_at  timestamptz,             -- set once the owners have been escalated; cleared when the deadline changes
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
-- review_log entry shape (one per delivery round):
--   { "round": 0, "deadline": "<iso|null>", "submitted_at": "<iso>",
--     "on_time": true, "changes_requested_at": "<iso|null>", "notes": "<text|null>" }
-- round = revision_count at submission time (0 = initial delivery, 1+ = revision deliveries).
-- on_time = submitted_at <= deadline (null when no deadline applied to that round).

create index if not exists tasks_assigned_to_idx on tasks(assigned_to);
create index if not exists tasks_status_idx      on tasks(status);
create index if not exists tasks_deadline_idx    on tasks(deadline);
create index if not exists tasks_client_id_idx   on tasks(client_id);

-- ── Migration from previous WhatsApp version ──────────────────────────────────
-- If you have an existing database with whatsapp_number, run this to migrate:
--
--   alter table editors rename column whatsapp_number to telegram_id;
--
-- Then update each editor's telegram_id to their Telegram chat ID.

-- ── Migration: editor file deliverables ───────────────────────────────────────
-- If you already created the tasks table before file-upload support, run:
--
--   alter table tasks add column if not exists deliverable_file_id   text;
--   alter table tasks add column if not exists deliverable_file_type text;
--   alter table tasks add column if not exists deliverable_file_name text;
--   alter table tasks add column if not exists deliverable_uploaded_at timestamptz;

-- ── Migration: change-request / revision loop ─────────────────────────────────
-- If you already created the tasks table before the revision feature, run:
--
--   alter table tasks add column if not exists deliverable_owner_msgs jsonb;
--   alter table tasks add column if not exists revision_count int not null default 0;
--   alter table tasks add column if not exists revision_notes text;
--   alter table tasks add column if not exists revision_requested_at timestamptz;

-- ── Migration: work-record lifecycle history ──────────────────────────────────
-- If you already created the tasks table before the per-task history view, run:
--
--   alter table tasks add column if not exists initial_deadline timestamptz;
--   alter table tasks add column if not exists first_submitted_at timestamptz;
--   alter table tasks add column if not exists review_log jsonb not null default '[]'::jsonb;
--   -- Backfill original deadline for tasks that never went through a revision:
--   update tasks set initial_deadline = deadline
--     where initial_deadline is null and coalesce(revision_count, 0) = 0;
--
-- Until this runs, the bot degrades gracefully: submissions/revisions skip the
-- history writes (best-effort), the dashboard shows "Not recorded", and the task
-- detail page falls back to the scalar columns it still has.

-- ── Migration: approval flow (submitted_for_review status) ─────────────────────
-- If you already created the tasks table before the approval feature, the status
-- CHECK constraint must be widened to allow the new 'submitted_for_review' value.
-- (The constraint name is auto-generated; the block below finds and replaces it.)
--
--   alter table tasks drop constraint if exists tasks_status_check;
--   alter table tasks add constraint tasks_status_check
--     check (status in ('pending', 'in_progress', 'blocked', 'submitted_for_review', 'completed'));
--
-- Until this runs, the bot degrades gracefully: work the employee marks "done"
-- stays 'in_progress' (instead of 'submitted_for_review') but owners still get
-- the Approve / Request Changes prompt.

-- ── Migration: workflow features (pre-deadline reminders, escalation, priority, leave) ──
-- If you already created the tables before these features, run:
--
--   alter table tasks   add column if not exists reminders_sent jsonb not null default '[]'::jsonb;
--   alter table tasks   add column if not exists escalated_at timestamptz;
--   alter table tasks   add column if not exists priority text not null default 'normal'
--     check (priority in ('low', 'normal', 'high', 'urgent'));
--   alter table editors add column if not exists available boolean not null default true;
--
-- Until this runs, the bot degrades gracefully: pre-deadline reminders and the
-- persistent-escalation flag are best-effort (skipped with a console warning),
-- priority falls back to 'normal' on display, and every editor is treated as
-- available by the load balancer.

-- ── Seed example clients ──────────────────────────────────────────────────────

-- insert into clients (name) values
--   ('Acme Brand'),
--   ('Studio X'),
--   ('Wedding Films Co');

-- ── Seed example employees ────────────────────────────────────────────────────

-- insert into editors (name, telegram_id, role) values
--   ('Rahul',  '123456001', array['editor','shoot']),
--   ('Priya',  '123456002', array['graphic_designer']),
--   ('Arjun',  '123456003', array['editor','graphic_designer']);
