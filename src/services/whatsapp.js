const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('../config');
const fs = require('fs');
const { execSync } = require('child_process');

// whatsapp-web.js uses "919876543210@c.us" format; we store E.164 "+919876543210".
// Tolerate legacy Twilio-style "whatsapp:+91..." values and any stray spaces/dashes.
function toWaId(e164) {
  const digits = e164.replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
  return digits + '@c.us';
}

function fromWaId(waId) {
  return '+' + waId.replace(/@c\.us$/, '');
}

// Use already-installed Chrome on Windows to avoid downloading a separate browser
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
];
const systemChrome = CHROME_PATHS.find((p) => fs.existsSync(p));

if (!systemChrome) {
  console.warn('[Bot] ⚠️  Chrome not found at common paths. whatsapp-web.js will attempt to download Chromium.');
  console.warn('[Bot] For best results, install Google Chrome and restart.');
}

// Force kill Chrome processes on Windows (fallback cleanup)
function killChromeProcesses() {
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /IM chrome.exe /F 2>nul || true', { stdio: 'ignore' });
      execSync('taskkill /IM chromium.exe /F 2>nul || true', { stdio: 'ignore' });
    }
  } catch (e) {
    // Ignore errors from taskkill
  }
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: systemChrome || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-web-resources',
      '--disable-sync',
      '--disable-blink-features=AutomationControlled',
    ],
  },
});

// Track initialization attempts to prevent infinite loops
let initializationAttempts = 0;
const MAX_INIT_ATTEMPTS = 3;
let isInitializing = false;
let initializationTimeout = null;

// Cache: E.164 → raw WA ID (could be @c.us or @lid)
// Populated when a message is received so replies use the correct format.
const waIdCache = new Map();

function registerWaId(e164, rawWaId) {
  waIdCache.set(e164, rawWaId);
}

async function sendMessage(to, body) {
  const waId = waIdCache.get(to) || toWaId(to);
  // Return the sent Message so callers can capture its id (used to link a task to its
  // assignment message, so editors can quote-reply to update the right task).
  return client.sendMessage(waId, body);
}

// Broadcast to every owner. Used for notifications that all owners should see
// (new assignments, completions, blocks, escalations, the daily digest).
async function sendToOwners(body) {
  const results = [];
  for (const number of config.owners) {
    try {
      results.push(await sendMessage(number, body));
    } catch (err) {
      console.error(`[Bot] Failed to send to owner ${number}:`, err.message);
    }
  }
  return results;
}

// Backward-compatible alias — now fans out to all owners.
const sendToOwner = sendToOwners;

// Safe initialization with timeout and error handling
async function safeInitialize() {
  if (isInitializing) {
    console.log('[Bot] Initialization already in progress, waiting...');
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (!isInitializing) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 500);
    });
  }

  if (initializationAttempts >= MAX_INIT_ATTEMPTS) {
    console.error('[Bot] ❌ Max initialization attempts reached. Manual intervention required.');
    console.error('[Bot] Try these steps:');
    console.error('[Bot]   1. Delete the ".wwebjs_auth" folder');
    console.error('[Bot]   2. Ensure Google Chrome is installed');
    console.error('[Bot]   3. Restart the application');
    return;
  }

  isInitializing = true;
  initializationAttempts++;

  // Clear any existing timeout
  if (initializationTimeout) {
    clearTimeout(initializationTimeout);
  }

  console.log(`[Bot] Initializing WhatsApp client (attempt ${initializationAttempts}/${MAX_INIT_ATTEMPTS})...`);

  try {
    // Set a timeout to prevent indefinite hanging (45 seconds for first attempt, 30 for retries)
    const timeoutDuration = initializationAttempts === 1 ? 45000 : 30000;
    const initPromise = client.initialize();
    
    initializationTimeout = setTimeout(async () => {
      console.warn('[Bot] ⚠️  Initialization timeout - browser may have crashed. Cleaning up...');
      try {
        await client.destroy();
        console.log('[Bot] Browser destroyed.');
      } catch (e) {
        console.warn('[Bot] Failed to destroy client:', e.message);
      }
      killChromeProcesses();
    }, timeoutDuration);

    await initPromise;
    clearTimeout(initializationTimeout);
    console.log('[Bot] ✅ Client initialized successfully');
    isInitializing = false;
  } catch (error) {
    clearTimeout(initializationTimeout);
    console.error('[Bot] ❌ Initialization error:', error.message);
    isInitializing = false;

    // Aggressive cleanup
    try {
      await client.destroy();
      await new Promise(r => setTimeout(r, 1500)); // Wait for cleanup
    } catch (cleanupError) {
      console.warn('[Bot] Cleanup error:', cleanupError.message);
    }
    killChromeProcesses();
    await new Promise(r => setTimeout(r, 1000));

    const isRecoverable = 
      error.message.includes('Execution context was destroyed') || 
      error.message.includes('Target page, context or frame was detached') ||
      error.message.includes('Session closed') ||
      error.message.includes('already running') ||
      error.message.includes('disconnected') ||
      error.message.includes('crashed');

    if (isRecoverable && initializationAttempts < MAX_INIT_ATTEMPTS) {
      console.log(`[Bot] Recoverable error detected. Waiting ${2}s before retry (${MAX_INIT_ATTEMPTS - initializationAttempts} attempts remaining)...`);
      await new Promise(r => setTimeout(r, 2000));
      return safeInitialize();
    } else if (isRecoverable) {
      throw new Error('Max retry attempts exceeded: ' + error.message);
    } else {
      throw error;
    }
  }
}

module.exports = { client, sendMessage, sendToOwner, sendToOwners, fromWaId, registerWaId, safeInitialize };
