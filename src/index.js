require('dotenv').config();
const path = require('path');
const express = require('express');
const compression = require('compression');
const config = require('./config');
const { bot, extractFile } = require('./services/telegram');
const { handleIncomingMessage, handleIncomingFile } = require('./handlers/messageHandler');
const { handleCallbackQuery } = require('./handlers/callbackHandler');
const { startScheduler } = require('./jobs/scheduler');

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
  // Only handle private chats
  if (msg.chat.type !== 'private') return;

  const chatId = String(msg.chat.id);

  // If the sender replied to a previous message, capture that message ID so
  // handlers can pinpoint exactly which task the update refers to.
  const quotedMsgId = msg.reply_to_message?.message_id?.toString() || null;

  // ── File / media message (document, photo, video, …) ─────────────────────────
  const file = extractFile(msg);
  if (file) {
    console.log(`[FILE] From: ${chatId} | ${file.fileType}${file.fileName ? ' ' + file.fileName : ''}${msg.caption ? ' | caption: ' + msg.caption.slice(0, 40) : ''}${quotedMsgId ? ' | (quoted reply)' : ''}`);
    handleIncomingFile(chatId, { ...file, caption: msg.caption || '' }, quotedMsgId).catch((err) => {
      console.error('[Bot] Error handling file:', err);
    });
    return;
  }

  // ── Text message ─────────────────────────────────────────────────────────────
  if (!msg.text || !msg.text.trim()) return;
  const text = msg.text;

  console.log(`[MSG] From: ${chatId} | Body: ${text.slice(0, 80)}${quotedMsgId ? ' | (quoted reply)' : ''}`);

  handleIncomingMessage(chatId, text, quotedMsgId).catch((err) => {
    console.error('[Bot] Error handling message:', err);
  });
});

// Connect to Telegram and start the scheduler
bot.getMe().then((me) => {
  console.log(`[Bot] ✅ Telegram bot @${me.username} is running!`);
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
