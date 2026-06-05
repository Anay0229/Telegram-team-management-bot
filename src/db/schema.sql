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
  active      boolean not null default true,
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
                  check (status in ('pending', 'in_progress', 'blocked', 'completed')),
  deadline      timestamptz,
  drive_link    text,
  blocked_reason text,
  note          text,                    -- optional note from management, sent to the employee on assignment
  assignment_msg_id text,                -- Telegram message_id for reply-based task matching
  started_at    timestamptz,             -- set on first transition to in_progress
  deadline_notified_at timestamptz,      -- last past-deadline nudge timestamp
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

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
