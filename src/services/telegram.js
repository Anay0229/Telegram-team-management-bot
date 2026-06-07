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
async function sendFile(chatId, { fileId, fileType, caption }) {
  const id = String(chatId);
  const opts = caption ? { caption, parse_mode: 'Markdown' } : {};
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
async function sendFileToOwners({ fileId, fileType, caption }) {
  const results = [];
  for (const id of config.owners) {
    try {
      const sent = await sendFile(id, { fileId, fileType, caption });
      results.push({ ownerId: String(id), messageId: sent?.message_id ?? null });
    } catch (err) {
      console.error(`[Bot] Failed to send file to owner ${id}:`, err.message);
    }
  }
  return results;
}

module.exports = { bot, sendMessage, sendToOwner, sendToOwners, extractFile, sendFile, sendFileToOwners };
