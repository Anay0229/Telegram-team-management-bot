const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('[Bot] ❌ TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// The bot's own @username and numeric id, learned from getMe() at startup. Needed
// in group mode to detect when the bot is tagged / replied to. Set via setBotIdentity.
let botUsername = null;
let botId = null;
function setBotIdentity({ username, id }) { botUsername = username || null; botId = id || null; }
function getBotUsername() { return botUsername; }
function getBotId() { return botId; }

// `replyMarkup` (optional) attaches an inline keyboard: { inline_keyboard: [[...]] }.
async function sendMessage(chatId, text, replyMarkup) {
  const opts = { parse_mode: 'Markdown' };
  if (replyMarkup) opts.reply_markup = replyMarkup;
  try {
    return await bot.sendMessage(String(chatId), text, opts);
  } catch (err) {
    if (err.response?.body?.description?.includes('parse')) {
      // Markdown parsing failed (e.g. unmatched * or _ in user-entered text) — send plain
      const plain = text.replace(/[*_`]/g, '');
      const plainOpts = replyMarkup ? { reply_markup: replyMarkup } : {};
      return bot.sendMessage(String(chatId), plain, plainOpts);
    }
    console.error(`[Bot] Failed to send to ${chatId}:`, err.message);
    throw err;
  }
}

async function sendToOwners(text, replyMarkup) {
  // Group mode: one message to the shared group instead of a DM per owner.
  if (config.groupId) {
    try {
      return [await sendMessage(config.groupId, text, replyMarkup)];
    } catch (err) {
      console.error(`[Bot] Failed to send to group ${config.groupId}:`, err.message);
      return [];
    }
  }
  const results = [];
  for (const id of config.owners) {
    try {
      results.push(await sendMessage(id, text, replyMarkup));
    } catch (err) {
      console.error(`[Bot] Failed to send to owner ${id}:`, err.message);
    }
  }
  return results;
}

// Answers a callback_query so Telegram stops the button's loading spinner.
// `text` (optional) shows a brief toast to the user. Best-effort — never throws.
async function answerCallback(callbackQueryId, text, showAlert = false) {
  try {
    await bot.answerCallbackQuery(callbackQueryId, text ? { text, show_alert: showAlert } : {});
  } catch (err) {
    console.warn('[Bot] answerCallbackQuery failed:', err.message);
  }
}

// Replaces (or clears, when markup is null) the inline keyboard on an existing
// message — used to "consume" buttons once an action has been taken so they
// can't be tapped twice. Best-effort: stale/old messages simply stay as-is.
async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  try {
    await bot.editMessageReplyMarkup(replyMarkup || { inline_keyboard: [] }, {
      chat_id: String(chatId),
      message_id: messageId,
    });
  } catch (err) {
    // "message is not modified" / "message to edit not found" are non-fatal.
    console.warn('[Bot] editMessageReplyMarkup failed:', err.message);
  }
}

const sendToOwner = sendToOwners;

// Pulls the relevant file out of an inbound Telegram message, normalising the
// many media shapes (photo/video/document/…) into { fileId, fileType, fileName }.
// Returns null when the message carries no file. Order matters: animation and
// video_note must be checked before document/video because Telegram populates
// several fields at once for those.
function extractFile(msg) {
  if (!msg) return null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    // Photos come as an array of sizes; the last entry is the largest.
    return { fileType: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id, fileName: null };
  }
  if (msg.animation) {
    return { fileType: 'animation', fileId: msg.animation.file_id, fileName: msg.animation.file_name || null };
  }
  if (msg.video_note) {
    return { fileType: 'video_note', fileId: msg.video_note.file_id, fileName: null };
  }
  if (msg.video) {
    return { fileType: 'video', fileId: msg.video.file_id, fileName: msg.video.file_name || null };
  }
  if (msg.audio) {
    return { fileType: 'audio', fileId: msg.audio.file_id, fileName: msg.audio.file_name || msg.audio.title || null };
  }
  if (msg.voice) {
    return { fileType: 'voice', fileId: msg.voice.file_id, fileName: null };
  }
  if (msg.document) {
    return { fileType: 'document', fileId: msg.document.file_id, fileName: msg.document.file_name || null };
  }
  return null;
}

// Re-sends a file (by Telegram file_id) to a chat using the method matching its
// type. video_note can't carry a caption, so the caption is sent separately.
async function sendFile(chatId, { fileId, fileType, caption, replyMarkup }) {
  const id = String(chatId);
  const opts = caption ? { caption, parse_mode: 'Markdown' } : {};
  if (replyMarkup) opts.reply_markup = replyMarkup;
  try {
    switch (fileType) {
      case 'photo':     return await bot.sendPhoto(id, fileId, opts);
      case 'video':     return await bot.sendVideo(id, fileId, opts);
      case 'animation': return await bot.sendAnimation(id, fileId, opts);
      case 'audio':     return await bot.sendAudio(id, fileId, opts);
      case 'voice':     return await bot.sendVoice(id, fileId, opts);
      case 'video_note': {
        const sent = await bot.sendVideoNote(id, fileId);
        if (caption) await sendMessage(id, caption);
        return sent;
      }
      case 'document':
      default:          return await bot.sendDocument(id, fileId, opts);
    }
  } catch (err) {
    // Caption Markdown can fail on user-supplied names — retry without parsing.
    if (caption && err.response?.body?.description?.includes('parse')) {
      const plain = { caption: caption.replace(/[*_`]/g, '') };
      if (replyMarkup) plain.reply_markup = replyMarkup;
      switch (fileType) {
        case 'photo':     return bot.sendPhoto(id, fileId, plain);
        case 'video':     return bot.sendVideo(id, fileId, plain);
        case 'animation': return bot.sendAnimation(id, fileId, plain);
        case 'audio':     return bot.sendAudio(id, fileId, plain);
        case 'voice':     return bot.sendVoice(id, fileId, plain);
        case 'document':
        default:          return bot.sendDocument(id, fileId, plain);
      }
    }
    console.error(`[Bot] Failed to send file to ${id}:`, err.message);
    throw err;
  }
}

// Returns [{ ownerId, messageId }] so callers can map the forwarded file back to
// a task (used so owners can reply to the file to request changes).
async function sendFileToOwners({ fileId, fileType, caption, replyMarkup }) {
  // Group mode: forward once to the shared group. The group's chat id stands in as
  // the "ownerId" so reply-to-file change requests resolve against it.
  if (config.groupId) {
    try {
      const sent = await sendFile(config.groupId, { fileId, fileType, caption, replyMarkup });
      return [{ ownerId: String(config.groupId), messageId: sent?.message_id ?? null }];
    } catch (err) {
      console.error(`[Bot] Failed to send file to group ${config.groupId}:`, err.message);
      return [];
    }
  }
  const results = [];
  for (const id of config.owners) {
    try {
      const sent = await sendFile(id, { fileId, fileType, caption, replyMarkup });
      results.push({ ownerId: String(id), messageId: sent?.message_id ?? null });
    } catch (err) {
      console.error(`[Bot] Failed to send file to owner ${id}:`, err.message);
    }
  }
  return results;
}

module.exports = {
  bot, sendMessage, sendToOwner, sendToOwners, extractFile, sendFile, sendFileToOwners,
  answerCallback, editMessageReplyMarkup,
  setBotIdentity, getBotUsername, getBotId,
};
