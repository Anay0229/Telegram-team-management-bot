const config = require('../config');
const db = require('../db/supabase');
const { sendMessage } = require('../services/telegram');
const { handleOwnerMessage, handleOwnerFile } = require('./ownerHandler');
const { handleEditorMessage, handleEditorFile } = require('./editorHandler');

/**
 * Entry point for every inbound Telegram message.
 * senderId is who sent it (used for auth). chatId is where to reply and where
 * multi-step state lives — the owners group in group mode, otherwise the same as
 * senderId (a private chat). The two diverge only in the shared owners group.
 */
async function handleIncomingMessage(senderId, chatId, body, quotedMsgId) {
  if (!body || !body.trim()) return;

  const inGroup = config.isGroup(chatId);
  console.log(`[MSG] Sender: "${senderId}" | Chat: "${chatId}" | IsOwner: ${config.isOwner(senderId)}${inGroup ? ' | (group)' : ''}`);

  // ── Owner (any of the configured owners) ────────────────────────────────────
  // Replies + pending state are keyed by chatId so the group conversation stays
  // coherent (and a private chat behaves exactly as before, chatId === senderId).
  if (config.isOwner(senderId)) {
    await handleOwnerMessage(chatId, body, quotedMsgId);
    return;
  }

  // In the owners group, ignore non-owner members rather than spamming them.
  if (inGroup) return;

  // ── Editor ─────────────────────────────────────────────────────────────────
  const editor = await db.getEditorByTelegramId(senderId);
  if (editor) {
    await handleEditorMessage(editor, body, quotedMsgId);
    return;
  }

  // ── Unknown sender ─────────────────────────────────────────────────────────
  await sendMessage(
    chatId,
    `👋 Hi! This is the Framex Originals team bot.\n\nYou are not registered in the system. Please contact your manager to get added.`
  );
}

/**
 * Entry point for every inbound file/media message (document, photo, video, …).
 * file is { fileId, fileType, fileName, caption } extracted from the Telegram message.
 * See handleIncomingMessage for the senderId vs chatId distinction.
 */
async function handleIncomingFile(senderId, chatId, file, quotedMsgId) {
  // Owners' files only matter while assembling a change request (reference
  // attachments after tapping 🔁 Request Changes); otherwise they're ignored.
  if (config.isOwner(senderId)) {
    await handleOwnerFile(chatId, file);
    return;
  }

  if (config.isGroup(chatId)) return;

  const editor = await db.getEditorByTelegramId(senderId);
  if (editor) {
    await handleEditorFile(editor, file, quotedMsgId);
    return;
  }

  // Unknown sender — mirror the text path so they know to get registered.
  await sendMessage(
    chatId,
    `👋 Hi! This is the Framex Originals team bot.\n\nYou are not registered in the system. Please contact your manager to get added.`
  );
}

module.exports = { handleIncomingMessage, handleIncomingFile };
