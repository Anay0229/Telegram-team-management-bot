require('dotenv').config();

// Parse one or more owner Telegram chat IDs (comma-separated).
// These are the numeric Telegram user IDs of people who can assign and manage work.
// To find your Telegram chat ID: message the bot and check server logs, or use @userinfobot.
const ownerIds = (process.env.OWNER_TELEGRAM_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const config = {
  owners: ownerIds, // array of Telegram chat ID strings — every person who can assign/manage work
  // Optional shared owners group. When set, the bot posts all owner updates to this
  // single group chat (owners tag the bot to issue commands) instead of DMing each
  // owner individually. Leave unset to keep the per-owner DM behaviour.
  groupId: process.env.GROUP_CHAT_ID || null,
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  drive: {
    rawFiles: process.env.DRIVE_RAW_FILES || 'https://drive.google.com/drive/folders/17T8DMPxtNekREoCm8wE3j6E5enVXzS9V',
    finalData: process.env.DRIVE_FINAL_DATA || 'https://drive.google.com/drive/folders/1RKZgLxrA-bCpUvcNeSdmwrI3zTnRsas1',
  },
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
};

// Load score weights (per PRD §6.3)
config.loadScore = {
  activeTaskWeight: 10,
  urgentTaskWeight: 5,   // due within 48 hrs
  blockedTaskWeight: 3,
  urgentWindowHours: 48,
};

// Pre-deadline reminders: warn the assigned editor this many hours BEFORE a
// deadline (in addition to the at-deadline reminder). Each threshold fires once.
config.reminders = {
  preDeadlineHours: [24, 2],
  // When an editor taps "Got it 👍" on a reminder, suppress further pre-deadline
  // reminders for that task for this many hours.
  snoozeHours: 4,
};

// Owner notification behaviour.
config.notifications = {
  // Ping the owners when an editor acknowledges ("Got it 👍") a reminder. Off by
  // default — the whole point of the snooze is to cut noise, not add a new ping.
  notifyOwnerOnAcknowledge: false,
};

// Escalation tiers (hours past deadline). Each tier fires exactly once; after the
// last fixed tier the alert repeats once every 24h until the owner taps "Mark Seen"
// or the task leaves in_progress. Keep ascending.
config.escalation = {
  tiers: [2, 6, 12],
  dailyAfterHours: 12, // once past this, re-alert at most once per 24h
};

// Quiet hours for OWNER escalation alerts (24h clock, in `tz`). During this window
// non-critical escalations are held and flushed once it ends, so a 2 AM overdue
// task doesn't wake anyone. Block alerts always go through (they're sent directly
// from the handlers, not the scheduler). Set enabled:false to opt out.
config.quietHours = {
  enabled: true,
  start: 23,              // 11 PM
  end: 8,                 // 8 AM
  tz: 'Asia/Kolkata',     // matches the scheduler's cron timezone
};

// The current hour (0–23) in the quiet-hours timezone, independent of the server's
// local zone — so this behaves the same wherever the bot is hosted.
function hourInTz(date, tz) {
  const s = date.toLocaleString('en-US', { timeZone: tz, hour: '2-digit', hour12: false });
  const h = parseInt(s, 10);
  return h === 24 ? 0 : h; // some runtimes render midnight as "24"
}

// True when `date` (default: now) falls inside the quiet-hours window. Handles the
// window wrapping past midnight (start > end).
config.isQuietHour = (date = new Date()) => {
  if (!config.quietHours.enabled) return false;
  const h = hourInTz(date, config.quietHours.tz);
  const { start, end } = config.quietHours;
  return start <= end ? (h >= start && h < end) : (h >= start || h < end);
};

// True if the given Telegram chat ID belongs to an owner.
config.isOwner = (chatId) => config.owners.includes(String(chatId));

// True if the given chat ID is the configured owners group.
config.isGroup = (chatId) => !!config.groupId && String(chatId) === String(config.groupId);

module.exports = config;
