# Framex Originals — WhatsApp Team Management System
### Product Requirements Document (PRD) v1.0
**Date:** June 3, 2026 | **Status:** Draft — Pending Approval

---

## 1. Executive Summary

Framex Originals is a production house specialising in pre- and post-production. As the team scales, tracking editor workloads and routing new projects manually over WhatsApp becomes error-prone and time-consuming.

This PRD defines requirements and an implementation plan for a **WhatsApp-native team management bot** that automates task assignment, workload tracking, and Google Drive file delivery — all without requiring editors or the owner to leave WhatsApp.

The system connects two existing Google Drive folders:
- **Raw Files** — `https://drive.google.com/drive/folders/17T8DMPxtNekREoCm8wE3j6E5enVXzS9V`
- **Final Data** — `https://drive.google.com/drive/folders/1RKZgLxrA-bCpUvcNeSdmwrI3zTnRsas1`

---

## 2. Problem Statement

- No centralised view of who is working on what at any given time
- New project assignments happen informally, causing some editors to be overloaded while others are idle
- Google Drive links are shared ad hoc with no tracking
- No automated deadline reminders or escalation when work is blocked
- No daily digest for the owner to assess team health at a glance

---

## 3. Goals & Non-Goals

### Goals
- Allow the owner to assign projects to editors directly through WhatsApp
- Automatically recommend the least-loaded editor for each new project
- Let editors update task status (`started`, `done`, `blocked`) via WhatsApp keywords
- Auto-share the relevant Google Drive folder link when a task is assigned
- Send a morning digest to the owner summarising active tasks, completions, and blockers
- Nudge editors with deadline reminders 24 hours before due dates

### Non-Goals (v1.0)
- Not a replacement for a full PM tool (Asana, Monday, etc.)
- Will not process or analyse video/audio files directly
- Will not integrate with billing, invoicing, or client portals
- Will not support file uploads through WhatsApp

---

## 4. User Roles

| Role | WhatsApp Persona | Key Capabilities |
|------|-----------------|-----------------|
| Owner (you) | Admin number | Add projects, confirm assignments, view team dashboard, receive daily digest |
| Editor | Individual numbers | Receive assignments, update status, get file links and deadline reminders |

---

## 5. Functional Requirements

### 5.1 Project Intake & Assignment
1. Owner sends command: project name, type (pre/post), deadline
2. Bot queries DB and calculates load score per editor
3. Bot presents ranked editor list with load summary to owner
4. Owner confirms editor choice (reply with number or name)
5. Bot notifies editor on WhatsApp with project details + Google Drive link

### 5.2 Google Drive Integration
- Both Drive folder links stored in server config
- Pre-production task assigned → **Raw Files** link sent automatically
- Post-production task assigned → **Final Data** link sent automatically
- Owner can override with a specific sub-folder link during intake
- Editors can request links on demand: `send raw folder` / `send final folder`

### 5.3 Status Tracking

| Keyword / Command | Action |
|-------------------|--------|
| `started` / `in progress` | Mark task In Progress, record timestamp |
| `done` / `completed` | Mark task Completed, notify owner |
| `blocked [reason]` | Mark task Blocked, immediately alert owner with reason |
| `my tasks` | Bot replies with editor's active task list |
| `help` | Bot replies with all available commands |

### 5.4 Owner Dashboard Commands
- `team status` — all editors, active tasks, and statuses
- `[editor name] status` — drill-down on a specific editor
- `overdue` — all tasks past their deadline
- `completed today` — tasks completed in the last 24 hours

### 5.5 Automated Reminders & Digest
- **Daily digest** to owner at 9:00 AM — team summary, overdue tasks, prior day completions
- **24-hour reminder** to assigned editor before deadline
- **Escalation alert** to owner if a task is still In Progress 2 hours after deadline

---

## 6. Technical Architecture

### 6.1 System Components

| Component | Technology | Purpose |
|-----------|------------|---------|
| WhatsApp Interface | Twilio WhatsApp API (or Meta Cloud API) | Send/receive messages |
| Backend Server | Node.js (Express) on Railway or Render | Bot logic, load balancing, cron jobs |
| Database | Supabase (PostgreSQL) or Airtable | Editors, tasks, deadlines, status |
| Google Drive | Config-stored links (Drive API optional) | Forward folder links to editors |
| Scheduler | node-cron | Morning digest, reminders, escalations |

### 6.2 Data Model

**Editors Table**

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Primary key |
| name | String | Full name |
| whatsapp_number | String | E.164 format |
| role | String | pre-production / post-production / both |
| active | Boolean | Currently available |

**Tasks Table**

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Primary key |
| project_name | String | Name of the project |
| type | String | pre-production / post-production |
| assigned_to | FK → Editors | Assigned editor |
| status | Enum | pending / in_progress / blocked / completed |
| deadline | DateTime | Project deadline |
| drive_link | String | Drive link forwarded to editor |
| created_at | DateTime | Task creation time |
| completed_at | DateTime | Completion timestamp |

### 6.3 Load Balancing Formula

```
Load Score = (Active Tasks × 10) + (Tasks due within 48 hrs × 5) + (Blocked Tasks × 3)
```

Lowest score = recommended first. Ties broken by fewest total assigned tasks (all time).

### 6.4 Google Drive Folder Config

| Folder | Link | Auto-sent for |
|--------|------|--------------|
| Raw Files | https://drive.google.com/drive/folders/17T8DMPxtNekREoCm8wE3j6E5enVXzS9V | Pre-production tasks |
| Final Data | https://drive.google.com/drive/folders/1RKZgLxrA-bCpUvcNeSdmwrI3zTnRsas1 | Post-production tasks |

---

## 7. Implementation Plan

### Phase 1 — Foundation (Week 1–2)

| Task | Description |
|------|-------------|
| Set up WhatsApp API | Create Twilio account, register sandbox, test send/receive |
| Set up backend server | Node.js + Express on Railway, webhook endpoint |
| Set up database | Supabase project, Editors and Tasks tables |
| Register editors | Add all editor numbers and roles to DB |
| Config Drive links | Store Drive URLs as environment variables |

### Phase 2 — Core Bot Logic (Week 3–4)

| Task | Description |
|------|-------------|
| Message parser | Detect commands: new project, status updates, queries |
| Load balancer | Implement load score algorithm, return ranked editor list |
| Assignment flow | Owner confirms → DB updated → editor notified with Drive link |
| Status keywords | Handle started / done / blocked, update DB |
| Owner dashboard | `team status`, `overdue`, `completed today` commands |

### Phase 3 — Automation & Polish (Week 5)

| Task | Description |
|------|-------------|
| Daily digest scheduler | 9 AM cron → build and send morning summary to owner |
| Deadline reminders | 24-hr before deadline → remind editor |
| Escalation alerts | 2 hrs after deadline if still in progress → alert owner |
| Drive link commands | On-demand `send raw folder` / `send final folder` |
| Error handling | Unknown commands → help menu; invalid editor → retry prompt |

### Phase 4 — Testing & Launch (Week 6)

| Task | Description |
|------|-------------|
| Internal testing | Owner + 1–2 editors test all flows in sandbox |
| Edge case handling | Offline editor, duplicate assignments, blank deadlines |
| Production cutover | Switch from Twilio sandbox to production WhatsApp number |
| Team onboarding | Welcome message to all editors with command reference |

---

## 8. Timeline Summary

| Phase | Duration | Key Milestone |
|-------|----------|--------------|
| Phase 1: Foundation | Week 1–2 | Bot online, DB live, editors registered |
| Phase 2: Core Logic | Week 3–4 | Full assignment & status tracking working |
| Phase 3: Automation | Week 5 | Digest, reminders, Drive links live |
| Phase 4: Launch | Week 6 | Production go-live, full team onboarded |

> Estimated total: **5–6 weeks** with one developer. Can compress to 3–4 weeks with two developers on Phases 1–2 in parallel.

---

## 9. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Meta WhatsApp API approval delay | Medium | High | Use Twilio sandbox first; migrate to Meta once approved |
| Editor WhatsApp numbers change | Low | Medium | Owner updates numbers via bot command |
| Google Drive links change | Low | Medium | Links in config; owner updates via command |
| Bot misreads status keywords | Medium | Low | Fuzzy matching + confirmation for ambiguous messages |
| Server downtime | Low | High | Railway/Render with auto-restart + uptime monitoring |

---

## 10. Success Metrics

- 100% of new project assignments go through the bot within 30 days of launch
- Owner spends less than 5 minutes per day on task routing
- Zero missed deadline reminders
- All editors can check tasks and update status without contacting the owner directly
- Daily digest delivered by 9:05 AM every working day

---

## 11. Appendix — Sample Bot Commands

### Owner Commands

| Command Example | Bot Response |
|----------------|-------------|
| `new project: Short Film Grade \| post-production \| deadline: 10 Jun` | Load summary + recommended editor, asks to confirm |
| `assign to Rahul` | Confirms, notifies Rahul with Final Data Drive link |
| `team status` | All editors with active task count and status |
| `overdue` | All tasks past their deadline |
| `completed today` | Tasks completed in last 24 hours |

### Editor Commands

| Command Example | Bot Response |
|----------------|-------------|
| `started` | Marks current task as In Progress |
| `done` | Marks Completed, notifies owner |
| `blocked – waiting for client approval` | Marks Blocked, alerts owner with reason |
| `my tasks` | Lists all active tasks for this editor |
| `send raw folder` | Replies with Raw Files Google Drive link |
| `send final folder` | Replies with Final Data Google Drive link |

---

*Framex Originals — Confidential | PRD v1.0 | June 2026*
