require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const path = require('path');
const fs = require('fs-extra');

const SessionDB  = require('./database');
const { extractArchive, collectFiles, detectArchiveType, formatBytes, isPasswordProtected, SUPPORTED_FORMATS } = require('./extractor');
const { downloadFile, MAX_FILE_SIZE_MB }      = require('./downloader');
const { cleanupSession, cleanupStaleSessions, getUserTempDir } = require('./cleanup');
const { Messages, Keyboards, escMd }          = require('./messages');

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is not set in .env file!');
  process.exit(1);
}

const TEMP_DIR = process.env.TEMP_DIR || './temp';
const AUTO_SEND_LIMIT = 10;

// ─── Bot Init ─────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ─── Middleware ───────────────────────────────────────────────────────────────

// Ignore edited messages
bot.on('edited_message', () => {});

// Log all incoming
bot.use(async (ctx, next) => {
  const user = ctx.from;
  if (user) {
    console.log(`[${new Date().toISOString()}] User: ${user.id} (${user.username || user.first_name}) | Type: ${ctx.updateType}`);
  }
  return next();
});

// ─── Helper: safe reply ───────────────────────────────────────────────────────
async function safeReply(ctx, text, extra = {}) {
  try {
    return await ctx.replyWithMarkdownV2(text, extra);
  } catch (err) {
    console.error('Reply error:', err.message);
    // Fallback plain text
    try {
      return await ctx.reply(text.replace(/[*_`[\]()~>#+=|{}.!\\-]/g, ''), extra);
    } catch {}
  }
}

async function safeEdit(ctx, messageId, text, extra = {}) {
  try {
    return await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, text, {
      parse_mode: 'MarkdownV2',
      ...extra
    });
  } catch {}
}

// ─── Archive Handler ───────────────────────────────────────────────────────────
async function handleArchiveExtraction(ctx, userId, archiveName, archiveUrl, archiveType, fileSize) {
  const userTempDir  = getUserTempDir(userId);
  const archivePath  = path.join(userTempDir, 'archive' + path.extname(archiveName.toLowerCase()));
  const extractDir   = path.join(userTempDir, 'extracted');

  await fs.ensureDir(userTempDir);
  await fs.ensureDir(extractDir);

  // Init session
  SessionDB.upsertSession(userId, {
    state: 'downloading',
    archive_path: archivePath,
    extract_dir: extractDir,
    original_name: archiveName,
    archive_type: archiveType,
    file_list: [],
    total_files: 0
  });

  // Step 1: Download
  const dlMsg = await safeReply(ctx, Messages.downloading(archiveName), Keyboards.cancel());
  let dlMsgId = dlMsg?.message_id;

  try {
    await downloadFile(archiveUrl, archivePath);
  } catch (err) {
    await cleanupSession(userId);
    if (err.message.startsWith('FILE_TOO_LARGE')) {
      return safeReply(ctx, Messages.errorFileTooLarge(MAX_FILE_SIZE_MB), Keyboards.backToMenu());
    }
    return safeReply(ctx, Messages.errorGeneral(err.message), Keyboards.backToMenu());
  }

  // Step 2: Check if password protected
  const encrypted = await isPasswordProtected(archivePath);
  if (encrypted) {
    SessionDB.updateSession(userId, { state: 'waiting_password' });
    if (dlMsgId) await safeEdit(ctx, dlMsgId, Messages.needsPassword(), Keyboards.cancel());
    else await safeReply(ctx, Messages.needsPassword(), Keyboards.cancel());
    return;
  }

  // Step 3: Extract
  await performExtraction(ctx, userId, null, dlMsgId);
}

// ─── Extraction Step ──────────────────────────────────────────────────────────
async function performExtraction(ctx, userId, password = null, editMsgId = null) {
  const session = SessionDB.getSession(userId);
  if (!session) return;

  SessionDB.updateSession(userId, { state: 'extracting', password: password || null });

  // Show extracting message
  if (editMsgId) {
    await safeEdit(ctx, editMsgId, Messages.extracting(session.original_name));
  } else {
    await safeReply(ctx, Messages.extracting(session.original_name));
  }

  // Extract
  const result = await extractArchive(session.archive_path, session.extract_dir, password);

  if (!result.success) {
    if (result.needsPassword) {
      if (password) {
        // Wrong password
        SessionDB.updateSession(userId, { state: 'waiting_password' });
        return safeReply(ctx, Messages.wrongPassword(), Keyboards.cancel());
      } else {
        SessionDB.updateSession(userId, { state: 'waiting_password' });
        return safeReply(ctx, Messages.needsPassword(), Keyboards.cancel());
      }
    }

    if (result.error === 'no_7z') {
      await cleanupSession(userId);
      return safeReply(ctx, Messages.error7zMissing(), Keyboards.backToMenu());
    }

    await cleanupSession(userId);
    return safeReply(ctx, Messages.errorGeneral(result.error), Keyboards.backToMenu());
  }

  // Step 4: Scan files
  await safeReply(ctx, Messages.scanningFiles());
  const files = await collectFiles(session.extract_dir);

  if (files.length === 0) {
    await cleanupSession(userId);
    return safeReply(ctx, Messages.errorNoFiles(), Keyboards.backToMenu());
  }

  const totalSize = formatBytes(files.reduce((acc, f) => acc + f.size, 0));

  SessionDB.updateSession(userId, {
    state: 'ready_to_send',
    file_list: files,
    total_files: files.length
  });

  // Log stats
  SessionDB.logStat(userId, 'extract_success', session.original_name, files.length);

  // Show success
  await safeReply(ctx, Messages.extractionSuccess(session.original_name, files.length, totalSize));

  // Step 5: Decide send mode
  if (files.length <= AUTO_SEND_LIMIT) {
    await sendFiles(ctx, userId, files.length);
  } else {
    await safeReply(
      ctx,
      Messages.askHowMany(files.length, totalSize),
      Keyboards.fileCountOptions(files.length)
    );
  }
}

// ─── File Sender ──────────────────────────────────────────────────────────────
async function sendFiles(ctx, userId, count) {
  const session = SessionDB.getSession(userId);
  if (!session || !session.file_list || session.file_list.length === 0) return;

  const files = session.file_list.slice(0, count);
  const progressMsg = await safeReply(ctx, Messages.sendingAllFiles(count));
  let sent = 0;

  for (const file of files) {
    try {
      const stat = await fs.stat(file.fullPath).catch(() => null);
      if (!stat) continue;

      // Telegram max file size is 50MB for bots
      if (stat.size > 50 * 1024 * 1024) {
        await ctx.reply(`⚠️ Skipping (too large for Telegram): ${file.name} (${file.sizeFormatted})`);
        continue;
      }

      // Update progress every 5 files
      if (sent % 5 === 0 && progressMsg) {
        await safeEdit(ctx, progressMsg.message_id, Messages.sendingFiles(sent + 1, files.length));
      }

      await ctx.replyWithDocument(
        { source: file.fullPath, filename: file.name },
        { caption: `📄 \`${escMd(file.relativePath)}\` • ${escMd(file.sizeFormatted)}`, parse_mode: 'MarkdownV2' }
      );
      sent++;

      // Small delay to avoid flood
      if (sent % 10 === 0) await sleep(1000);
    } catch (err) {
      console.error(`Error sending file ${file.name}:`, err.message);
      await ctx.reply(`⚠️ Failed to send: ${file.name}`).catch(() => {});
    }
  }

  // Cleanup
  await cleanupSession(userId);

  await safeReply(ctx, Messages.allFilesSent(sent), Keyboards.mainMenu());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  await cleanupSession(ctx.from.id); // Reset any stale session
  await safeReply(ctx, Messages.welcome(ctx.from.first_name), Keyboards.mainMenu());
});

bot.help(async (ctx) => {
  await safeReply(ctx, Messages.help(), Keyboards.backToMenu());
});

bot.command('stats', async (ctx) => {
  const data = SessionDB.getStats();
  await safeReply(ctx, Messages.stats(data), Keyboards.backToMenu());
});

bot.command('cancel', async (ctx) => {
  await cleanupSession(ctx.from.id);
  await safeReply(ctx, Messages.cancelled(), Keyboards.mainMenu());
});

// ─── Callback Queries ─────────────────────────────────────────────────────────

bot.action('extract_start', async (ctx) => {
  await ctx.answerCbQuery();
  await cleanupSession(ctx.from.id);
  SessionDB.upsertSession(ctx.from.id, { state: 'waiting_archive' });
  await safeReply(ctx, Messages.waitingForArchive(), Keyboards.cancel());
});

bot.action('show_stats', async (ctx) => {
  await ctx.answerCbQuery();
  const data = SessionDB.getStats();
  await safeReply(ctx, Messages.stats(data), Keyboards.backToMenu());
});

bot.action('show_help', async (ctx) => {
  await ctx.answerCbQuery();
  await safeReply(ctx, Messages.help(), Keyboards.backToMenu());
});

bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await cleanupSession(ctx.from.id);
  await safeReply(ctx, Messages.welcome(ctx.from.first_name), Keyboards.mainMenu());
});

bot.action('cancel_session', async (ctx) => {
  await ctx.answerCbQuery('Session cancelled');
  await cleanupSession(ctx.from.id);
  await safeReply(ctx, Messages.cancelled(), Keyboards.mainMenu());
});

bot.action('send_count_custom', async (ctx) => {
  await ctx.answerCbQuery();
  const session = SessionDB.getSession(ctx.from.id);
  if (!session) return;
  SessionDB.updateSession(ctx.from.id, { state: 'waiting_count' });
  await safeReply(ctx, Messages.askCustomNumber(session.total_files), Keyboards.cancel());
});

// Handle "send N files" buttons
bot.action(/^send_count_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const count = parseInt(ctx.match[1]);
  const session = SessionDB.getSession(ctx.from.id);
  if (!session || session.state !== 'ready_to_send') {
    return safeReply(ctx, '⚠️ Session expired\\. Please start again\\.', Keyboards.mainMenu());
  }
  const actualCount = Math.min(count, session.total_files);
  await sendFiles(ctx, ctx.from.id, actualCount);
});

// Handle confirm_send
bot.action(/^confirm_send_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const count = parseInt(ctx.match[1]);
  await sendFiles(ctx, ctx.from.id, count);
});

// ─── Document Handler ─────────────────────────────────────────────────────────

bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const doc    = ctx.message.document;
  const name   = doc.file_name || 'archive';
  const nameLower = name.toLowerCase();

  // Check format
  const archiveType = detectArchiveType(nameLower);
  const isSupported = SUPPORTED_FORMATS.some(ext => nameLower.endsWith(ext));

  if (!archiveType && !isSupported) {
    const session = SessionDB.getSession(userId);
    // Only show error if they are in waiting_archive state
    if (session?.state === 'waiting_archive') {
      return safeReply(ctx, Messages.errorUnsupported(), Keyboards.cancel());
    }
    return; // Ignore non-archive files when not in extraction mode
  }

  // Check file size
  if (doc.file_size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    return safeReply(ctx, Messages.errorFileTooLarge(MAX_FILE_SIZE_MB), Keyboards.backToMenu());
  }

  // Get file URL
  let fileUrl;
  try {
    const fileInfo = await ctx.telegram.getFile(doc.file_id);
    fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
  } catch (err) {
    return safeReply(ctx, Messages.errorGeneral('Failed to get file URL'), Keyboards.backToMenu());
  }

  // Auto-start extraction (even if they didn't press the button)
  const session = SessionDB.getSession(userId);
  if (session && session.state !== 'idle' && session.state !== 'waiting_archive') {
    await cleanupSession(userId);
  }

  await handleArchiveExtraction(ctx, userId, name, fileUrl, archiveType, doc.file_size);
});

// ─── Text Handler ─────────────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text   = ctx.message.text.trim();
  const session = SessionDB.getSession(userId);

  if (!session) {
    // No session — show main menu
    return safeReply(ctx, Messages.welcome(ctx.from.first_name), Keyboards.mainMenu());
  }

  // Handle password input
  if (session.state === 'waiting_password') {
    await performExtraction(ctx, userId, text);
    return;
  }

  // Handle custom file count
  if (session.state === 'waiting_count') {
    const num = parseInt(text);
    if (isNaN(num) || num < 1) {
      return safeReply(ctx, `❌ *Please enter a valid number*`, Keyboards.cancel());
    }
    const actualCount = Math.min(num, session.total_files);
    SessionDB.updateSession(userId, { state: 'ready_to_send' });
    await sendFiles(ctx, userId, actualCount);
    return;
  }

  // Default: show main menu
  await safeReply(ctx, Messages.welcome(ctx.from.first_name), Keyboards.mainMenu());
});

// ─── Error Handler ────────────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`❌ Bot error for user ${ctx?.from?.id}:`, err);

  if (err.code === 403) return; // User blocked bot
  if (err.code === 400 && err.description?.includes('message is not modified')) return;

  const userId = ctx?.from?.id;
  if (userId) {
    cleanupSession(userId).catch(() => {});
    safeReply(ctx, Messages.errorGeneral(err.message), Keyboards.mainMenu()).catch(() => {});
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  // Ensure directories exist
  await fs.ensureDir(TEMP_DIR);
  await fs.ensureDir(path.dirname(process.env.DB_PATH || './data/zipfy.db'));

  // Cleanup stale sessions on startup
  await cleanupStaleSessions();

  // Run stale cleanup every 30 minutes
  setInterval(cleanupStaleSessions, 30 * 60 * 1000);

  // Get bot info
  const botInfo = await bot.telegram.getMe();
  console.log(`
╔══════════════════════════════════════╗
║         🗜️  ZipFy Bot Started         ║
╚══════════════════════════════════════╝
  Bot:      @${botInfo.username}
  Name:     ${botInfo.first_name}
  Node.js:  ${process.version}
  Mode:     ${process.env.NODE_ENV || 'development'}
  Time:     ${new Date().toISOString()}
`);

  // Start polling
  await bot.launch();
}

// Graceful shutdown
process.once('SIGINT',  () => { console.log('\n👋 Stopping bot...'); bot.stop('SIGINT');  });
process.once('SIGTERM', () => { console.log('\n👋 Stopping bot...'); bot.stop('SIGTERM'); });

start().catch(err => {
  console.error('❌ Failed to start bot:', err);
  process.exit(1);
});
