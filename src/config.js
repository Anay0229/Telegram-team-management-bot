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

// True if the given Telegram chat ID belongs to an owner.
config.isOwner = (chatId) => config.owners.includes(String(chatId));

module.exports = config;
