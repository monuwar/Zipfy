const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');

const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '100');
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * Download a file from a URL to a local path
 */
async function downloadFile(url, destPath, onProgress = null) {
  await fs.ensureDir(path.dirname(destPath));

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    let downloaded = 0;
    let totalSize = 0;

    const req = protocol.get(url, { timeout: 120000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        downloadFile(res.headers.location, destPath, onProgress)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: Failed to download file`));
        return;
      }

      totalSize = parseInt(res.headers['content-length'] || '0');

      if (totalSize > MAX_FILE_SIZE_BYTES) {
        req.destroy();
        reject(new Error(`FILE_TOO_LARGE:${MAX_FILE_SIZE_MB}`));
        return;
      }

      const writeStream = fs.createWriteStream(destPath);
      res.pipe(writeStream);

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (downloaded > MAX_FILE_SIZE_BYTES) {
          req.destroy();
          writeStream.destroy();
          fs.removeSync(destPath);
          reject(new Error(`FILE_TOO_LARGE:${MAX_FILE_SIZE_MB}`));
          return;
        }
        if (onProgress && totalSize > 0) {
          const percent = Math.round((downloaded / totalSize) * 100);
          onProgress(percent, downloaded, totalSize);
        }
      });

      writeStream.on('finish', () => resolve(destPath));
      writeStream.on('error', reject);
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Download timeout after 120 seconds'));
    });

    req.on('error', reject);
  });
}

/**
 * Get file size from Telegram file object
 */
function getFileSizeMB(fileSize) {
  return (fileSize / (1024 * 1024)).toFixed(1);
}

module.exports = { downloadFile, getFileSizeMB, MAX_FILE_SIZE_MB };
