const cron = require('node-cron');
const db = require('../db/supabase');
const { sendMessage, sendToOwner } = require('../services/telegram');
const fmt = require('../services/formatters');

const ESCALATION_WINDOW_MS = 2 * 60 * 60 * 1000;       // 2 hours past deadline

// Track which tasks have already been escalated this run to avoid duplicates.
const escalatedTaskIds = new Set();

function startScheduler() {
  const tz = { timezone: 'Asia/Kolkata' };

  // ── Daily digest — 9:00 AM every day ──────────────────────────────────────
  cron.schedule('0 9 * * *', sendDailyDigest, tz);

  // ── Deadline reminders — every minute ─────────────────────────────────────
  // Fires the moment a task's deadline is reached (never early). The
  // deadline_notified_at flag guarantees exactly one reminder per task.
  cron.schedule('* * * * *', sendDeadlineReminders, tz);

  // ── Escalation alerts to owners — every 10 min ────────────────────────────
  cron.schedule('*/10 * * * *', sendEscalationAlerts, tz);

  console.log('[Scheduler] Cron jobs started (tz Asia/Kolkata): digest @09:00, deadline reminders every minute, escalations every 10 min.');
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
    const tasks = await db.getTasksStillInProgressAfterDeadline();
    const now = Date.now();
    let sent = 0;
    for (const task of tasks) {
      if (escalatedTaskIds.has(task.id)) continue;
      const deadlineTime = task.deadline ? new Date(task.deadline).getTime() : 0;
      if (now - deadlineTime < ESCALATION_WINDOW_MS) continue; // not 2 hrs past yet
      await sendToOwner(
        `🚨 *Escalation Alert*\n\n` +
        `Project *${task.project_name}* is still In Progress *2+ hours after its deadline*.\n\n` +
        `Editor: ${task.editors?.name || 'Unknown'}\n` +
        `Deadline was: ${fmt.fmtDeadline(task.deadline)}\n\n` +
        `Please follow up immediately.`
      );
      escalatedTaskIds.add(task.id);
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
  sendDeadlineReminders,
  sendEscalationAlerts,
};
