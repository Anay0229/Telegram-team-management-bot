require('dotenv').config();
const path = require('path');
const express = require('express');
const compression = require('compression');
const config = require('./config');
const { bot, extractFile, setBotIdentity, getBotUsername, getBotId } = require('./services/telegram');
const { handleIncomingMessage, handleIncomingFile } = require('./handlers/messageHandler');
const { handleCallbackQuery } = require('./handlers/callbackHandler');
const { startScheduler } = require('./jobs/scheduler');
const { pendingAssignments, pendingChangeNotes } = require('./handlers/pendingState');

// ── Group-mode helpers ────────────────────────────────────────────────────────
// A mid-conversation flow (assignment confirmation / change notes) lets the owner
// reply in the group without re-tagging the bot. Keyed by chat id (the group).
function hasPendingForChat(chatId) {
  return pendingAssignments.has(chatId) || pendingChangeNotes.has(chatId);
}

// True when the bot is @mentioned in the message text or caption.
function botMentioned(msg) {
  const username = getBotUsername();
  if (!username) return false;
  const text = (msg.text || msg.caption || '').toLowerCase();
  return text.includes('@' + username.toLowerCase());
}

// True when the message is a reply to one of the bot's own messages.
function isReplyToBot(msg) {
  const id = getBotId();
  return !!(id && msg.reply_to_message?.from?.id === id);
}

// Removes the "@botname" tag so the command parser sees a clean command.
function stripMention(text) {
  const username = getBotUsername();
  if (!username || !text) return text;
  const re = new RegExp('@' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  return text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
}

// ── Telegram bot events ───────────────────────────────────────────────────────

bot.on('polling_error', (err) => {
  console.error('[Bot] Polling error:', err.code, err.message);
});

// Inline-button taps (Started / Done / Blocked / Approve / Request Changes / assign).
bot.on('callback_query', (query) => {
  console.log(`[CALLBACK] From: ${query.from?.id} | data: ${query.data}`);
  handleCallbackQuery(query).catch((err) => {
    console.error('[Bot] Error handling callback:', err);
  });
});

bot.on('message', async (msg) => {
  const chatType = msg.chat.type;
  const chatId = String(msg.chat.id);
  const senderId = String(msg.from?.id ?? chatId);

  const isPrivate = chatType === 'private';
  const isOwnerGroup = config.isGroup(chatId);

  // Handle private chats and the one configured owners group; ignore everything
  // else (other groups the bot might be added to, channels, etc.).
  if (!isPrivate && !isOwnerGroup) {
    // Log unknown group ids once so the operator can copy theirs into GROUP_CHAT_ID.
    if (chatType === 'group' || chatType === 'supergroup') {
      console.log(`[GROUP] Message in unconfigured group ${chatId} — set GROUP_CHAT_ID to this to enable group mode.`);
    }
    return;
  }

  // If the sender replied to a previous message, capture that message ID so
  // handlers can pinpoint exactly which task the update refers to.
  const quotedMsgId = msg.reply_to_message?.message_id?.toString() || null;

  // In the group, only act when the bot is tagged, replied to, or a multi-step
  // flow is mid-conversation — otherwise ignore normal group chatter.
  if (isOwnerGroup) {
    const triggered = botMentioned(msg) || isReplyToBot(msg) || hasPendingForChat(chatId);
    if (!triggered) return;
  }

  // ── File / media message (document, photo, video, …) ─────────────────────────
  const file = extractFile(msg);
  if (file) {
    const caption = isOwnerGroup ? stripMention(msg.caption || '') : (msg.caption || '');
    console.log(`[FILE] From: ${senderId} | Chat: ${chatId} | ${file.fileType}${file.fileName ? ' ' + file.fileName : ''}${caption ? ' | caption: ' + caption.slice(0, 40) : ''}${quotedMsgId ? ' | (quoted reply)' : ''}`);
    handleIncomingFile(senderId, chatId, { ...file, caption }, quotedMsgId).catch((err) => {
      console.error('[Bot] Error handling file:', err);
    });
    return;
  }

  // ── Text message ─────────────────────────────────────────────────────────────
  if (!msg.text || !msg.text.trim()) return;
  const text = isOwnerGroup ? stripMention(msg.text) : msg.text;
  if (!text.trim()) return;

  console.log(`[MSG] From: ${senderId} | Chat: ${chatId} | Body: ${text.slice(0, 80)}${quotedMsgId ? ' | (quoted reply)' : ''}`);

  handleIncomingMessage(senderId, chatId, text, quotedMsgId).catch((err) => {
    console.error('[Bot] Error handling message:', err);
  });
});

// Connect to Telegram and start the scheduler
bot.getMe().then((me) => {
  setBotIdentity({ username: me.username, id: me.id });
  console.log(`[Bot] ✅ Telegram bot @${me.username} is running!`);
  if (config.groupId) {
    console.log(`[Bot] 👥 Group mode ON — owner updates post to group ${config.groupId}. Tag @${me.username} to issue commands.`);
  }
  startScheduler();
}).catch((err) => {
  console.error('[Bot] ❌ Failed to connect to Telegram:', err.message);
  console.error('[Bot]    Check that TELEGRAM_BOT_TOKEN in .env is correct.');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[Bot] Uncaught exception:', err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Bot] Unhandled rejection:', reason);
});

// ── Express (health check + admin panel) ─────────────────────────────────────
const app = express();

// gzip text responses. level 4 is a deliberate trade-off: this server runs on a
// weak phone CPU shared with the Telegram polling loop, so we take most of the
// bandwidth win (text shrinks ~60% by level 3-4) without paying level-9 CPU cost.
app.use(compression({ level: 4 }));

app.use(express.urlencoded({ extended: false }));

// Static assets (admin.css, etc.) are content-stable — let the browser cache them
// for a month so the phone only ever uploads these bytes once per visitor.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '30d', immutable: true }));

const adminRouter = require('./routes/admin');
app.use('/admin', adminRouter);

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Framex Originals Telegram Bot' });
});

const server = app.listen(config.port, () => {
  console.log(`[Server] Listening on port ${config.port} — admin panel at http://localhost:${config.port}/admin`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[Server] ⚠️  ADMIN_PASSWORD is not set — the admin portal is UNPROTECTED.');
    console.warn('[Server]    Set ADMIN_PASSWORD in .env before exposing this server publicly.');
  }
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] ❌ Port ${config.port} is already in use.`);
    process.exit(1);
  } else {
    throw err;
  }
});
