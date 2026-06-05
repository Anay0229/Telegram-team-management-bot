const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('[Bot] ❌ TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

async function sendMessage(chatId, text) {
  try {
    return await bot.sendMessage(String(chatId), text, { parse_mode: 'Markdown' });
  } catch (err) {
    if (err.response?.body?.description?.includes('parse')) {
      // Markdown parsing failed (e.g. unmatched * or _ in user-entered text) — send plain
      const plain = text.replace(/[*_`]/g, '');
      return bot.sendMessage(String(chatId), plain);
    }
    console.error(`[Bot] Failed to send to ${chatId}:`, err.message);
    throw err;
  }
}

async function sendToOwners(text) {
  const results = [];
  for (const id of config.owners) {
    try {
      results.push(await sendMessage(id, text));
    } catch (err) {
      console.error(`[Bot] Failed to send to owner ${id}:`, err.message);
    }
  }
  return results;
}

const sendToOwner = sendToOwners;

module.exports = { bot, sendMessage, sendToOwner, sendToOwners };
