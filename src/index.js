require('dotenv').config();
const express = require('express');
const config = require('./config');
const { bot } = require('./services/telegram');
const { handleIncomingMessage } = require('./handlers/messageHandler');
const { startScheduler } = require('./jobs/scheduler');

// ── Telegram bot events ───────────────────────────────────────────────────────

bot.on('polling_error', (err) => {
  console.error('[Bot] Polling error:', err.code, err.message);
});

bot.on('message', async (msg) => {
  // Only handle text messages in private chats
  if (!msg.text || !msg.text.trim()) return;
  if (msg.chat.type !== 'private') return;

  const chatId = String(msg.chat.id);
  const text = msg.text;

  // If the sender replied to a previous message, capture that message ID so
  // handlers can pinpoint exactly which task the update refers to.
  const quotedMsgId = msg.reply_to_message?.message_id?.toString() || null;

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
app.use(express.urlencoded({ extended: false }));

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
