const cron = require('node-cron');
const db = require('../db/supabase');
const { sendMessage, sendToOwner } = require('../services/telegram');
const fmt = require('../services/formatters');

const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;       // 24 hours
const ESCALATION_WINDOW_MS = 2 * 60 * 60 * 1000;       // 2 hours past deadline

// Track which tasks have already received a reminder/escalation this cycle
// to avoid duplicate messages if the cron fires while a previous run is still processing.
const remindedTaskIds = new Set();
const escalatedTaskIds = new Set();

function startScheduler() {
  const tz = { timezone: 'Asia/Kolkata' };

  // ── Daily digest — 9:00 AM every day ──────────────────────────────────────
  cron.schedule('0 9 * * *', sendDailyDigest, tz);

  // ── 24-hr deadline reminders — every 10 min ───────────────────────────────
  // Runs often so reminders are timely and short-fuse tasks aren't missed; the
  // remindedTaskIds set keeps each task to a single reminder per window.
  cron.schedule('*/10 * * * *', sendDeadlineReminders, tz);

  // ── Escalation alerts — every 10 min ──────────────────────────────────────
  cron.schedule('*/10 * * * *', sendEscalationAlerts, tz);

  // ── Past-deadline editor nudges — every 10 min ────────────────────────────
  cron.schedule('5-59/10 * * * *', sendPastDeadlineEditorNudges, tz);

  console.log('[Scheduler] Cron jobs started (tz Asia/Kolkata): digest @09:00, reminders/escalations every 10 min, past-deadline nudges every 10 min.');
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

async function sendDeadlineReminders() {
  try {
    const tasks = await db.getTasksDueSoon(REMINDER_WINDOW_MS);
    let sent = 0, skipped = 0, noEditor = 0;
    for (const task of tasks) {
      if (remindedTaskIds.has(task.id)) { skipped++; continue; }
      const editor = task.editors;
      if (!editor || !editor.telegram_id) { noEditor++; continue; }
      await sendMessage(
        editor.telegram_id,
        `⏰ *Deadline Reminder*\n\n` +
        `Your project *${task.project_name}* is due in under 24 hours.\n` +
        `Deadline: ${fmt.fmtDeadline(task.deadline)}\n\n` +
        `Reply *done* when complete or *blocked [reason]* if you need help.`
      );
      remindedTaskIds.add(task.id);
      // Clear the reminder flag after 25 hours so it can fire again on a new window
      setTimeout(() => remindedTaskIds.delete(task.id), 25 * 60 * 60 * 1000);
      sent++;
    }
    if (tasks.length) {
      console.log(`[Scheduler] Deadline reminders: ${tasks.length} due within 24h → ${sent} sent, ${skipped} already-reminded${noEditor ? `, ${noEditor} missing-editor` : ''}.`);
    }
    return { dueSoon: tasks.length, sent, skipped, noEditor };
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

async function sendPastDeadlineEditorNudges() {
  try {
    const tasks = await db.getOverdueTasksNeedingEditorNotification();
    let sent = 0, noEditor = 0;
    for (const task of tasks) {
      const editor = task.editors;
      if (!editor || !editor.telegram_id) { noEditor++; continue; }
      const hoursOverdue = Math.round((Date.now() - new Date(task.deadline).getTime()) / 3600000);
      await sendMessage(
        editor.telegram_id,
        `⚠️ *Past Deadline — Action Needed*\n\n` +
        `Project *${task.project_name}* was due *${hoursOverdue} hour${hoursOverdue !== 1 ? 's' : ''} ago*.\n` +
        `Deadline: ${fmt.fmtDeadline(task.deadline)}\n\n` +
        `Please update your status:\n` +
        `• Reply *done* if you've finished\n` +
        `• Reply *blocked [reason]* if you need help\n\n` +
        `_Owners have been notified of the delay._`
      );
      await db.markTaskDeadlineNotified(task.id);
      sent++;
    }
    if (sent) console.log(`[Scheduler] Past-deadline nudges sent: ${sent} task(s).`);
    return { sent, noEditor };
  } catch (err) {
    console.error('[Scheduler] Past-deadline nudges failed:', err.message);
    return { error: err.message };
  }
}

module.exports = {
  startScheduler,
  sendDailyDigest,
  sendDeadlineReminders,
  sendEscalationAlerts,
  sendPastDeadlineEditorNudges,
};
