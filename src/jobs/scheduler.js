const cron = require('node-cron');
const db = require('../db/supabase');
const config = require('../config');
const { sendMessage, sendToOwner } = require('../services/telegram');
const fmt = require('../services/formatters');
const kb = require('../services/keyboards');

const HOUR_MS = 60 * 60 * 1000;
const ESCALATION_WINDOW_MS = 2 * HOUR_MS;              // 2 hours past deadline (legacy path)

// Fallback dedup used ONLY when the persistent escalated_at column isn't migrated
// yet. On the migrated path, dedup lives in the DB and survives restarts.
const escalatedTaskIds = new Set();

// Escalation alerts that came due during quiet hours, held in memory until the
// window ends (then flushed by the next escalation run). Process-local: a restart
// mid-quiet-hours drops anything still held, which is acceptable — the tier was
// already logged so it simply won't re-fire.
let heldEscalations = [];

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
      const digest = fmt.editorDashboardCard(editor, tasks);
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

      // Editor tapped "Got it 👍" recently — hold off on more pre-deadline pings.
      // (snoozed_until is undefined on an un-migrated schema → never skips.)
      if (task.snoozed_until && new Date(task.snoozed_until).getTime() > now) continue;

      const alreadySent = Array.isArray(task.reminders_sent) ? task.reminders_sent : [];
      const due = thresholds.filter((h) => hoursLeft <= h && !alreadySent.includes(h));
      if (!due.length) continue;

      // Send one heads-up now and mark every crossed threshold so we don't
      // double-ping when two thresholds lapse between runs. A "Got it" button lets
      // the editor snooze further pre-deadline reminders for this task.
      await sendMessage(editor.telegram_id, fmt.preDeadlineReminder(task, hoursLeft), kb.reminderButtons(task.id));
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

// Decides which escalation tier (if any) is due for an overdue in_progress task,
// based on its escalation_log. Tiers fire once each at +2h/+6h/+12h, then once per
// 24h ("daily"). Returns null when nothing is due or the owner acknowledged it.
function dueEscalationTier(task, now) {
  const log = Array.isArray(task.escalation_log) ? task.escalation_log : [];
  if (log.some((e) => e.tier === 'ack')) return null; // owner tapped "Mark Seen"

  const hoursOverdue = (now - new Date(task.deadline).getTime()) / HOUR_MS;
  const sent = new Set(log.filter((e) => e.tier !== 'ack').map((e) => e.tier));

  // Fixed tiers first, in order — so a long-overdue task that was never escalated
  // walks 2h → 6h → 12h on successive runs rather than jumping straight to daily.
  for (const t of config.escalation.tiers) {
    const key = `${t}h`;
    if (hoursOverdue >= t && !sent.has(key)) return { tier: key, hoursOverdue };
  }

  // After the last fixed tier, repeat at most once per 24h.
  if (hoursOverdue >= config.escalation.dailyAfterHours) {
    const stamps = log.filter((e) => e.tier !== 'ack').map((e) => new Date(e.at).getTime());
    const lastAt = stamps.length ? Math.max(...stamps) : 0;
    if (now - lastAt >= 24 * HOUR_MS) return { tier: 'daily', hoursOverdue };
  }
  return null;
}

function escalationMessage(task, due) {
  const hrs = Math.floor(due.hoursOverdue);
  const overdueText = hrs >= 24 ? `${Math.floor(hrs / 24)}+ day(s)` : `${hrs}+ hour(s)`;
  return (
    `🚨 *Escalation Alert*\n\n` +
    `🆔 \`${fmt.taskCode(task)}\`\n` +
    `Project *${task.project_name}* is still In Progress *${overdueText} past its deadline*.\n\n` +
    `Employee: ${task.editors?.name || 'Unknown'}\n` +
    `Deadline was: ${fmt.fmtDeadline(task.deadline)}\n\n` +
    `Tap *✅ Mark Seen* once you're handling it to stop further alerts.`
  );
}

async function sendEscalationAlerts() {
  try {
    let tasks;
    try {
      tasks = await db.getInProgressOverdueTasks();
    } catch (err) {
      // escalation_log column not migrated yet — use the legacy single-shot path.
      console.warn('[Scheduler] Tiered escalation unavailable (run the migration), using legacy path:', err.message);
      return legacyEscalationAlerts();
    }

    const now = Date.now();
    const quiet = config.isQuietHour();

    // Quiet hours are over and we have alerts held from overnight — send them now.
    if (!quiet && heldEscalations.length) {
      const flushed = heldEscalations.splice(0);
      for (const h of flushed) await sendToOwner(h.text, kb.escalationButtons(h.taskId));
      console.log(`[Scheduler] Flushed ${flushed.length} held escalation(s) after quiet hours.`);
    }

    let sent = 0, held = 0;
    for (const task of tasks) {
      const due = dueEscalationTier(task, now);
      if (!due) continue;

      const text = escalationMessage(task, due);
      // Record the tier before sending so a transient send failure can't replay the
      // same tier forever. If the write itself fails, skip (don't spam un-logged).
      try {
        await db.appendEscalationLog(task.id, { tier: due.tier, at: new Date().toISOString() });
      } catch (err) {
        console.warn('[Scheduler] Could not record escalation tier:', err.message);
        continue;
      }

      if (quiet) {
        // Hold non-critical alerts overnight; they flush when quiet hours end.
        heldEscalations.push({ text, taskId: task.id });
        held++;
      } else {
        await sendToOwner(text, kb.escalationButtons(task.id));
        sent++;
      }
    }
    if (sent || held) {
      console.log(`[Scheduler] Escalation alerts: ${sent} sent${held ? `, ${held} held (quiet hours)` : ''}.`);
    }
    return { sent, held };
  } catch (err) {
    console.error('[Scheduler] Escalation alerts failed:', err.message);
    return { error: err.message };
  }
}

// Legacy escalation: one alert per overdue task, no tiers, no quiet-hours hold.
// Used only until the escalation_log column is migrated in.
async function legacyEscalationAlerts() {
  try {
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
    if (sent) console.log(`[Scheduler] Escalation alerts (legacy): ${sent} sent.`);
    return { sent };
  } catch (err) {
    console.error('[Scheduler] Legacy escalation alerts failed:', err.message);
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
