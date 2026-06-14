-- ════════════════════════════════════════════════════════════════════════════
--  Framex Originals bot — consolidated migration
--  Run this ONCE in the Supabase SQL editor on an existing database.
--
--  It is safe to run more than once: every statement uses "if not exists" or
--  drops-then-recreates, so re-running it never errors and never loses data.
--
--  Why you need it: without these columns/constraints the bot "degrades
--  gracefully" — which is what makes a delivered task look like it vanished:
--    • "done" cannot set status = 'submitted_for_review', so the task silently
--      stays 'in_progress' and the Awaiting-Approval queue stays empty.
--    • the deliverable/history columns may be missing, so uploaded file names
--      and the per-task lifecycle never get recorded.
--  After running this, "done" puts the task into a visible "In Review" state and
--  every uploaded file is recorded.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Editor file deliverables ───────────────────────────────────────────────
alter table tasks add column if not exists deliverable_file_id     text;
alter table tasks add column if not exists deliverable_file_type   text;
alter table tasks add column if not exists deliverable_file_name   text;
alter table tasks add column if not exists deliverable_uploaded_at timestamptz;

-- ── 2. Change-request / revision loop ─────────────────────────────────────────
alter table tasks add column if not exists deliverable_owner_msgs jsonb;
alter table tasks add column if not exists revision_count int not null default 0;
alter table tasks add column if not exists revision_notes text;
alter table tasks add column if not exists revision_requested_at timestamptz;

-- ── 3. Reply-based task matching ──────────────────────────────────────────────
alter table tasks add column if not exists assignment_msg_id text;

-- ── 4. Work-record lifecycle history ──────────────────────────────────────────
alter table tasks add column if not exists initial_deadline   timestamptz;
alter table tasks add column if not exists first_submitted_at timestamptz;
alter table tasks add column if not exists review_log jsonb not null default '[]'::jsonb;
-- Backfill original deadline for tasks that never went through a revision:
update tasks set initial_deadline = deadline
  where initial_deadline is null and coalesce(revision_count, 0) = 0;

-- ── 5. Workflow features (pre-deadline reminders, escalation, priority, leave) ─
alter table tasks   add column if not exists reminders_sent jsonb not null default '[]'::jsonb;
alter table tasks   add column if not exists escalated_at timestamptz;
alter table tasks   add column if not exists priority text not null default 'normal';
alter table editors add column if not exists available boolean not null default true;

-- ── 6. Approval flow — widen the status CHECK to allow 'submitted_for_review' ──
-- This is the one that fixes the "done deletes my task" symptom: until the
-- constraint allows the new value, the bot falls back to 'in_progress'.
alter table tasks drop constraint if exists tasks_status_check;
alter table tasks add constraint tasks_status_check
  check (status in ('pending', 'in_progress', 'blocked', 'submitted_for_review', 'completed'));

-- Keep the priority CHECK in sync too (added separately so it can't block the above).
alter table tasks drop constraint if exists tasks_priority_check;
alter table tasks add constraint tasks_priority_check
  check (priority in ('low', 'normal', 'high', 'urgent'));
