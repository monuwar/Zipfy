const { Markup } = require('telegraf');

// ─── Inline Keyboards ─────────────────────────────────────────────────────────

const Keyboards = {
  // Main menu keyboard
  mainMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📦 Extract Files', 'extract_start')],
      [
        Markup.button.callback('📊 Stats', 'show_stats'),
        Markup.button.callback('ℹ️ Help', 'show_help')
      ],
      [Markup.button.url('👨‍💻 Developer', 'https://t.me/imonuwar')]
    ]);
  },

  // Cancel keyboard
  cancel(label = '❌ Cancel') {
    return Markup.inlineKeyboard([
      [Markup.button.callback(label, 'cancel_session')]
    ]);
  },

  // After extraction — show count options
  fileCountOptions(total) {
    const buttons = [];
    const options = [5, 10, 20, 50].filter(n => n < total);

    const row1 = [];
    const row2 = [];
    options.forEach((n, i) => {
      const btn = Markup.button.callback(`📄 ${n} files`, `send_count_${n}`);
      if (i < 2) row1.push(btn); else row2.push(btn);
    });

    if (row1.length) buttons.push(row1);
    if (row2.length) buttons.push(row2);
    buttons.push([Markup.button.callback(`📦 All ${total} files`, `send_count_${total}`)]);
    buttons.push([Markup.button.callback('✏️ Custom number', 'send_count_custom')]);
    buttons.push([Markup.button.callback('❌ Cancel', 'cancel_session')]);

    return Markup.inlineKeyboard(buttons);
  },

  // Confirm send
  confirmSend(count) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(`✅ Send ${count} files`, `confirm_send_${count}`),
        Markup.button.callback('❌ Cancel', 'cancel_session')
      ]
    ]);
  },

  // Back to menu
  backToMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')]
    ]);
  }
};

// ─── Message Templates ─────────────────────────────────────────────────────────

const Messages = {
  welcome(firstName) {
    return `
╔══════════════════════════╗
║   🗜️  *ZipFy Bot*  🗜️     ║
╚══════════════════════════╝

👋 Hello, *${firstName}*\\!

Welcome to *ZipFy* — your powerful archive extraction assistant\\!

*What I can do:*
📦 Extract ZIP, RAR, 7Z, TAR, TAR\\.GZ and more
🔐 Handle password\\-protected archives
📂 Recursively scan all nested folders
📤 Send extracted files directly to you
⚡ Fast, safe and secure extraction

*Supported Formats:*
\`ZIP • RAR • 7Z • TAR • TAR.GZ\`
\`TAR.BZ2 • TAR.XZ • GZ • BZ2\`

_Just send me any archive file to get started\\!_
    `.trim();
  },

  waitingForArchive() {
    return `
📥 *Ready to Extract\\!*

Please send me your archive file now\\.

*Supported formats:*
\`ZIP • RAR • 7Z • TAR • TAR\\.GZ • TAR\\.BZ2\`

⚠️ _Max file size: ${process.env.MAX_FILE_SIZE_MB || 100}MB_
    `.trim();
  },

  downloading(fileName) {
    return `⬇️ *Downloading archive\\.\\.\\.*\n\n📄 \`${escMd(fileName)}\``;
  },

  extracting(fileName) {
    return `
⚙️ *Extracting archive\\.\\.\\.*

📄 \`${escMd(fileName)}\`
🔄 _Please wait\\.\\.\\._
    `.trim();
  },

  needsPassword() {
    return `
🔐 *Password Required*

This archive is password\\-protected\\.

Please send me the password to unlock it\\.

_Type and send the password as a message:_
    `.trim();
  },

  wrongPassword() {
    return `
❌ *Wrong Password*

The password you entered is incorrect\\.

Please try again or press Cancel\\.
    `.trim();
  },

  scanningFiles() {
    return `🔍 *Scanning extracted files\\.\\.\\.*`;
  },

  extractionSuccess(fileName, fileCount, totalSize) {
    return `
✅ *Extraction Complete\\!*

📄 *Archive:* \`${escMd(fileName)}\`
📊 *Total Files:* \`${fileCount}\`
💾 *Total Size:* \`${escMd(totalSize)}\`
    `.trim();
  },

  sendingAllFiles(count) {
    return `📤 *Sending all ${count} file${count !== 1 ? 's' : ''}\\.\\.\\.*`;
  },

  askHowMany(total, totalSize) {
    return `
📂 *${total} files found\\!*

💾 *Total Size:* \`${escMd(totalSize)}\`

How many files would you like to receive?
_Select an option or type a custom number:_
    `.trim();
  },

  askCustomNumber(max) {
    return `✏️ *Enter a number between 1 and ${max}:*`;
  },

  sendingFiles(sent, total) {
    return `📤 *Sending file ${sent} of ${total}\\.\\.\\.*`;
  },

  allFilesSent(count) {
    return `
✅ *Done\\! All ${count} file${count !== 1 ? 's' : ''} sent\\!*

🧹 _Temporary files cleaned up_
🏠 Use the menu below to start again\\.
    `.trim();
  },

  errorGeneral(msg) {
    return `
❌ *Something went wrong*

\`${escMd(msg || 'Unknown error')}\`

Please try again or contact the developer\\.
    `.trim();
  },

  errorUnsupported() {
    return `
❌ *Unsupported Format*

This file format is not supported\\.

*Supported formats:*
\`ZIP • RAR • 7Z • TAR • TAR\\.GZ • TAR\\.BZ2 • TAR\\.XZ\`

Please send a valid archive file\\.
    `.trim();
  },

  errorFileTooLarge(maxMb) {
    return `
❌ *File Too Large*

Maximum allowed size is *${maxMb}MB*\\.

Please compress your archive or split it into smaller parts\\.
    `.trim();
  },

  errorNoFiles() {
    return `
⚠️ *No files found in archive*

The archive appears to be empty\\.

Please try a different archive file\\.
    `.trim();
  },

  error7zMissing() {
    return `
⚠️ *7-Zip Not Installed*

RAR and 7Z files require \`7-zip\` to be installed on the server\\.

*To install:*
\`sudo apt-get install p7zip-full\`
\`sudo apt-get install p7zip-rar\`

Please contact the administrator\\.
    `.trim();
  },

  stats(data) {
    return `
📊 *ZipFy Statistics*

👥 *Total Users:* \`${data.totalUsers}\`
🗜️ *Total Extractions:* \`${data.totalExtractions}\`
📄 *Total Files Sent:* \`${data.totalFiles}\`

_Powered by ZipFy Bot 🤖_
    `.trim();
  },

  help() {
    return `
ℹ️ *How to use ZipFy*

*Step 1:* Press 📦 Extract Files
*Step 2:* Send your archive file
*Step 3:* If password\\-protected, enter the password
*Step 4:* Choose how many files to receive
*Step 5:* Get your extracted files\\!

*Supported Formats:*
• ZIP \\— most common format
• RAR \\— requires 7\\-zip on server
• 7Z \\— high compression
• TAR\\.GZ \\— Linux/Unix standard
• TAR\\.BZ2 \\— better compression
• TAR\\.XZ \\— smallest compression
• GZ/BZ2 \\— single file compression

*Limits:*
• Max archive size: ${process.env.MAX_FILE_SIZE_MB || 100}MB
• Max extract size: ${process.env.MAX_EXTRACT_SIZE_MB || 500}MB

👨‍💻 *Developer:* @imonuwar
    `.trim();
  },

  cancelled() {
    return `
🚫 *Session Cancelled*

All temporary files have been cleaned up\\.
Use the menu to start again\\.
    `.trim();
  }
};

// Escape MarkdownV2 special characters
function escMd(text) {
  if (!text) return '';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

module.exports = { Messages, Keyboards, escMd };
