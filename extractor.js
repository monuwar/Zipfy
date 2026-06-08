const path = require('path');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');
const tar = require('tar');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const SUPPORTED_FORMATS = [
  '.zip', '.rar', '.7z',
  '.tar', '.tar.gz', '.tgz',
  '.tar.bz2', '.tbz2',
  '.tar.xz', '.txz',
  '.gz', '.bz2',
  '.tar.zst', '.tzst'
];

/**
 * Detect archive type from filename
 */
function detectArchiveType(filePath) {
  const name = filePath.toLowerCase();
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz'))  return 'tar.gz';
  if (name.endsWith('.tar.bz2') || name.endsWith('.tbz2')) return 'tar.bz2';
  if (name.endsWith('.tar.xz') || name.endsWith('.txz'))  return 'tar.xz';
  if (name.endsWith('.tar.zst') || name.endsWith('.tzst')) return 'tar.zst';
  if (name.endsWith('.tar'))   return 'tar';
  if (name.endsWith('.zip'))   return 'zip';
  if (name.endsWith('.rar'))   return 'rar';
  if (name.endsWith('.7z'))    return '7z';
  if (name.endsWith('.gz'))    return 'gz';
  if (name.endsWith('.bz2'))   return 'bz2';
  return null;
}

/**
 * Check if 7z is available on system
 */
async function is7zAvailable() {
  try {
    await execAsync('7z i');
    return true;
  } catch {
    try {
      await execAsync('7za i');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Get 7z binary name
 */
async function get7zBin() {
  try { await execAsync('7z i'); return '7z'; } catch {}
  try { await execAsync('7za i'); return '7za'; } catch {}
  return null;
}

/**
 * Extract ZIP using AdmZip
 */
async function extractZip(archivePath, destDir, password = null) {
  try {
    const zip = new AdmZip(archivePath);
    const entries = zip.getEntries();

    for (const entry of entries) {
      if (entry.isDirectory) continue;

      // Security: prevent path traversal
      const entryName = entry.entryName.replace(/\.\.\//g, '').replace(/\.\.\\/g, '');
      const targetPath = path.join(destDir, entryName);

      // Ensure target directory exists
      await fs.ensureDir(path.dirname(targetPath));

      if (password) {
        const data = zip.readFile(entry, password);
        if (!data) throw new Error('Wrong password or corrupted file');
        await fs.writeFile(targetPath, data);
      } else {
        zip.extractEntryTo(entry, path.dirname(targetPath), false, true, false, entry.name);
      }
    }
    return { success: true };
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes('password')) {
      return { success: false, needsPassword: true, error: err.message };
    }
    throw err;
  }
}

/**
 * Extract TAR variants
 */
async function extractTar(archivePath, destDir, archiveType) {
  await fs.ensureDir(destDir);

  const compressionMap = {
    'tar':     '',
    'tar.gz':  'gz',
    'tar.bz2': 'bz2',
    'tar.xz':  'xz',
    'tar.zst': 'zstd'
  };

  const compression = compressionMap[archiveType] || 'gz';

  await tar.x({
    file: archivePath,
    cwd: destDir,
    ...(compression ? { z: compression === 'gz', j: compression === 'bz2', J: compression === 'xz' } : {}),
    strict: false,
    filter: (p) => !p.includes('..') // security
  });

  return { success: true };
}

/**
 * Extract using 7z binary (handles RAR, 7z, and more)
 */
async function extractWith7z(archivePath, destDir, password = null) {
  const bin = await get7zBin();
  if (!bin) {
    return { success: false, error: 'no_7z', message: '7z binary not found' };
  }

  await fs.ensureDir(destDir);

  const passFlag = password ? `-p${password}` : '-p';
  const cmd = `${bin} x "${archivePath}" -o"${destDir}" ${passFlag} -y -mmt=2`;

  try {
    const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });
    const output = (stdout + stderr).toLowerCase();

    if (output.includes('wrong password') || output.includes('cannot open encrypted')) {
      return { success: false, needsPassword: true };
    }
    if (output.includes('error') && !output.includes('everything is ok')) {
      return { success: false, error: output };
    }
    return { success: true };
  } catch (err) {
    const msg = (err.stdout + err.stderr || err.message || '').toLowerCase();
    if (msg.includes('wrong password') || msg.includes('encrypted')) {
      return { success: false, needsPassword: true };
    }
    return { success: false, error: err.message };
  }
}

/**
 * Main extraction function
 */
async function extractArchive(archivePath, destDir, password = null) {
  const archiveType = detectArchiveType(archivePath);
  await fs.ensureDir(destDir);

  if (!archiveType) {
    return { success: false, error: 'Unsupported archive format' };
  }

  try {
    switch (archiveType) {
      case 'zip': {
        // Try 7z first for better password support, fallback to AdmZip
        const has7z = await is7zAvailable();
        if (has7z) {
          const result = await extractWith7z(archivePath, destDir, password);
          if (result.success || result.needsPassword) return result;
        }
        return await extractZip(archivePath, destDir, password);
      }

      case 'rar':
      case '7z': {
        return await extractWith7z(archivePath, destDir, password);
      }

      case 'tar':
      case 'tar.gz':
      case 'tar.bz2':
      case 'tar.xz':
      case 'tar.zst': {
        return await extractTar(archivePath, destDir, archiveType);
      }

      case 'gz':
      case 'bz2': {
        // Single compressed file — try with 7z
        return await extractWith7z(archivePath, destDir, password);
      }

      default:
        return { success: false, error: 'Unsupported format' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Recursively collect all files from a directory
 */
async function collectFiles(dirPath, basePath = dirPath) {
  const files = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      // Security: skip symlinks pointing outside
      try {
        const stat = await fs.lstat(fullPath);
        if (stat.isSymbolicLink()) continue;
      } catch { continue; }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const relativePath = path.relative(basePath, fullPath);
        const stat = await fs.stat(fullPath);
        files.push({
          fullPath,
          relativePath,
          name: entry.name,
          size: stat.size,
          sizeFormatted: formatBytes(stat.size)
        });
      }
    }
  }

  await walk(dirPath);
  return files;
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Check if archive is likely password protected (quick check)
 */
async function isPasswordProtected(archivePath) {
  const archiveType = detectArchiveType(archivePath);

  if (archiveType === 'zip') {
    try {
      const zip = new AdmZip(archivePath);
      const entries = zip.getEntries();
      return entries.some(e => e.header.encryptionMethod !== 0);
    } catch {
      return false;
    }
  }

  if (archiveType === 'rar' || archiveType === '7z') {
    const bin = await get7zBin();
    if (!bin) return false;
    try {
      const { stdout } = await execAsync(`${bin} l "${archivePath}"`, { timeout: 10000 });
      return stdout.toLowerCase().includes('encrypted') || stdout.includes('+');
    } catch {
      return true; // Assume encrypted on error
    }
  }

  return false;
}

module.exports = {
  extractArchive,
  collectFiles,
  detectArchiveType,
  formatBytes,
  isPasswordProtected,
  SUPPORTED_FORMATS
};
