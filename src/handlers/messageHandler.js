const config = require('../config');
const db = require('../db/supabase');
const { sendMessage } = require('../services/telegram');
const { handleOwnerMessage } = require('./ownerHandler');
const { handleEditorMessage } = require('./editorHandler');

/**
 * Entry point for every inbound Telegram message.
 * from is the Telegram chat ID string (e.g. "123456789").
 */
async function handleIncomingMessage(from, body, quotedMsgId) {
  if (!body || !body.trim()) return;

  console.log(`[MSG] From: "${from}" | Owners: [${config.owners.join(', ')}] | IsOwner: ${config.isOwner(from)}`);

  // ── Owner (any of the configured owners) ────────────────────────────────────
  if (config.isOwner(from)) {
    await handleOwnerMessage(from, body);
    return;
  }

  // ── Editor ─────────────────────────────────────────────────────────────────
  const editor = await db.getEditorByTelegramId(from);
  if (editor) {
    await handleEditorMessage(editor, body, quotedMsgId);
    return;
  }

  // ── Unknown sender ─────────────────────────────────────────────────────────
  await sendMessage(
    from,
    `👋 Hi! This is the Framex Originals team bot.\n\nYou are not registered in the system. Please contact your manager to get added.`
  );
}

module.exports = { handleIncomingMessage };
