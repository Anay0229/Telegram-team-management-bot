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
  // ── Daily digest — 9:00 AM every day ──────────────────────────────────────
  cron.schedule('0 9 * * *', sendDailyDigest, { timezone: 'Asia/Kolkata' });

  // ── 24-hr deadline reminders — every hour ─────────────────────────────────
  cron.schedule('0 * * * *', sendDeadlineReminders, { timezone: 'Asia/Kolkata' });

  // ── Escalation alerts — every 30 min ──────────────────────────────────────
  cron.schedule('*/30 * * * *', sendEscalationAlerts, { timezone: 'Asia/Kolkata' });

  // ── Past-deadline editor nudges — every hour ──────────────────────────────
  cron.schedule('15 * * * *', sendPastDeadlineEditorNudges, { timezone: 'Asia/Kolkata' });

  console.log('[Scheduler] All cron jobs started.');
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
    for (const task of tasks) {
      if (remindedTaskIds.has(task.id)) continue;
      const editor = task.editors;
      if (!editor) continue;
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
    }
  } catch (err) {
    console.error('[Scheduler] Deadline reminders failed:', err.message);
  }
}

async function sendEscalationAlerts() {
  try {
    const tasks = await db.getTasksStillInProgressAfterDeadline();
    const now = Date.now();
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
    }
  } catch (err) {
    console.error('[Scheduler] Escalation alerts failed:', err.message);
  }
}

async function sendPastDeadlineEditorNudges() {
  try {
    const tasks = await db.getOverdueTasksNeedingEditorNotification();
    for (const task of tasks) {
      const editor = task.editors;
      if (!editor) continue;
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
    }
    if (tasks.length) console.log(`[Scheduler] Past-deadline nudges sent: ${tasks.length} task(s).`);
  } catch (err) {
    console.error('[Scheduler] Past-deadline nudges failed:', err.message);
  }
}

module.exports = { startScheduler, sendDailyDigest };
