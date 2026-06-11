const cron = require('node-cron');
const db = require('../db/supabase');
const config = require('../config');
const { sendMessage, sendToOwner } = require('../services/telegram');
const fmt = require('../services/formatters');

const ESCALATION_WINDOW_MS = 2 * 60 * 60 * 1000;       // 2 hours past deadline

// Fallback dedup used ONLY when the persistent escalated_at column isn't migrated
// yet. On the migrated path, dedup lives in the DB and survives restarts.
const escalatedTaskIds = new Set();

function startScheduler() {
  const tz = { timezone: 'Asia/Kolkata' };

  // ── Per-editor digest — 8:30 AM (just before the owner digest) ────────────
  cron.schedule('30 8 * * *', sendEditorDigests, tz);

  // ── Daily digest — 9:00 AM every day ──────────────────────────────────────
  cron.schedule('0 9 * * *', sendDailyDigest, tz);

  // ── Pre-deadline reminders — every 15 min ─────────────────────────────────
  // Warns the editor ahead of a deadline (config.reminders.preDeadlineHours).
  cron.schedule('*/15 * * * *', sendPreDeadlineReminders, tz);

  // ── Deadline reminders — every minute ─────────────────────────────────────
  // Fires the moment a task's deadline is reached (never early). The
  // deadline_notified_at flag guarantees exactly one reminder per task.
  cron.schedule('* * * * *', sendDeadlineReminders, tz);

  // ── Escalation alerts to owners — every 10 min ────────────────────────────
  cron.schedule('*/10 * * * *', sendEscalationAlerts, tz);

  console.log('[Scheduler] Cron jobs started (tz Asia/Kolkata): editor digests @08:30, owner digest @09:00, pre-deadline reminders every 15 min, deadline reminders every minute, escalations every 10 min.');
}

// Sends each active editor a personalized morning digest of their active tasks.
// Editors with no active work are skipped so the digest never spams.
async function sendEditorDigests() {
  try {
    const editors = await db.getAllEditors();
    let sent = 0;
    for (const editor of editors) {
      if (!editor.telegram_id) continue;
      const tasks = await db.getTasksForEditorWithJoin(editor.id);
      const digest = fmt.editorDailyDigest(editor, tasks);
      if (!digest) continue; // no active tasks
      await sendMessage(editor.telegram_id, digest);
      sent++;
    }
    if (sent) console.log(`[Scheduler] Editor digests sent: ${sent}.`);
    return { sent };
  } catch (err) {
    console.error('[Scheduler] Editor digests failed:', err.message);
    return { error: err.message };
  }
}

async function sendDailyDigest() {
  try {
    const [activeTasks, overdueTasks, completedToday] = await Promise.all([
      db.getAllActiveTasks(),
      db.getOverdueTasks(),
      db.getCompletedToday(),
    ]);
    await sendToOwner(fmt.dailyDigest(activeTasks, overdueTasks, completedToday));
    console.log('[Scheduler] Daily digest sent.');
  } catch (err) {
    console.error('[Scheduler] Daily digest failed:', err.message);
  }
}

// Warns the assigned editor a configurable number of hours BEFORE the deadline
// (config.reminders.preDeadlineHours, e.g. [24, 2]). Each threshold fires once,
// tracked per task via the reminders_sent JSON array.
async function sendPreDeadlineReminders() {
  try {
    const thresholds = (config.reminders?.preDeadlineHours || []).slice().sort((a, b) => b - a);
    if (!thresholds.length) return { sent: 0 };

    const tasks = await db.getTasksDueSoon(thresholds[0] * 60 * 60 * 1000);
    const now = Date.now();
    let sent = 0;
    for (const task of tasks) {
      const editor = task.editors;
      if (!editor?.telegram_id || !task.deadline) continue;
      const hoursLeft = (new Date(task.deadline).getTime() - now) / 3600000;
      if (hoursLeft <= 0) continue; // at/after deadline → handled by sendDeadlineReminders

      const alreadySent = Array.isArray(task.reminders_sent) ? task.reminders_sent : [];
      const due = thresholds.filter((h) => hoursLeft <= h && !alreadySent.includes(h));
      if (!due.length) continue;

      // Send one heads-up now and mark every crossed threshold so we don't
      // double-ping when two thresholds lapse between runs.
      await sendMessage(editor.telegram_id, fmt.preDeadlineReminder(task, hoursLeft));
      try {
        await db.markReminderSent(task.id, [...alreadySent, ...due]);
      } catch (err) {
        console.warn('[Scheduler] markReminderSent skipped (run the migration):', err.message);
      }
      sent++;
    }
    if (sent) console.log(`[Scheduler] Pre-deadline reminders sent: ${sent}.`);
    return { sent };
  } catch (err) {
    console.error('[Scheduler] Pre-deadline reminders failed:', err.message);
    return { error: err.message };
  }
}

// Reminds the assigned editor the moment a task's deadline is reached — not before.
// Each task is reminded exactly once (tracked via deadline_notified_at).
async function sendDeadlineReminders() {
  try {
    const tasks = await db.getTasksAtDeadlineNeedingReminder();
    let sent = 0, noEditor = 0;
    for (const task of tasks) {
      const editor = task.editors;
      if (!editor || !editor.telegram_id) { noEditor++; continue; }
      await sendMessage(
        editor.telegram_id,
        `⏰ *Deadline Reached*\n\n` +
        `Your task *${task.project_name}* is due now.\n` +
        `Deadline: ${fmt.fmtDeadline(task.deadline)}\n\n` +
        `Reply *done* when complete, or *blocked [reason]* if you're stuck.`
      );
      await db.markTaskDeadlineNotified(task.id);
      sent++;
    }
    if (sent) console.log(`[Scheduler] Deadline reminders sent: ${sent}${noEditor ? `, ${noEditor} missing-editor` : ''}.`);
    return { due: tasks.length, sent, noEditor };
  } catch (err) {
    console.error('[Scheduler] Deadline reminders failed:', err.message);
    return { error: err.message };
  }
}

async function sendEscalationAlerts() {
  try {
    // Prefer the persistent path (dedup survives restarts via escalated_at). Fall
    // back to the in-memory Set if that column hasn't been migrated yet.
    let tasks, persistent = true;
    try {
      tasks = await db.getTasksNeedingEscalation(ESCALATION_WINDOW_MS);
    } catch (err) {
      persistent = false;
      console.warn('[Scheduler] Persistent escalation unavailable (run the migration):', err.message);
      tasks = await db.getTasksStillInProgressAfterDeadline();
    }

    const now = Date.now();
    let sent = 0;
    for (const task of tasks) {
      if (!persistent) {
        // Legacy dedup: skip if already alerted this run / not 2h past yet.
        if (escalatedTaskIds.has(task.id)) continue;
        const deadlineTime = task.deadline ? new Date(task.deadline).getTime() : 0;
        if (now - deadlineTime < ESCALATION_WINDOW_MS) continue;
      }
      await sendToOwner(
        `🚨 *Escalation Alert*\n\n` +
        `Project *${task.project_name}* is still In Progress *2+ hours after its deadline*.\n\n` +
        `Editor: ${task.editors?.name || 'Unknown'}\n` +
        `Deadline was: ${fmt.fmtDeadline(task.deadline)}\n\n` +
        `Please follow up immediately.`
      );
      if (persistent) {
        try {
          await db.markTaskEscalated(task.id);
        } catch (err) {
          console.warn('[Scheduler] markTaskEscalated failed:', err.message);
        }
      } else {
        escalatedTaskIds.add(task.id);
      }
      sent++;
    }
    if (sent) console.log(`[Scheduler] Escalation alerts: ${sent} sent.`);
    return { sent };
  } catch (err) {
    console.error('[Scheduler] Escalation alerts failed:', err.message);
    return { error: err.message };
  }
}

module.exports = {
  startScheduler,
  sendDailyDigest,
  sendEditorDigests,
  sendPreDeadlineReminders,
  sendDeadlineReminders,
  sendEscalationAlerts,
};
