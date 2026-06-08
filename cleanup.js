const fs = require('fs-extra');
const path = require('path');
const SessionDB = require('./database');

const TEMP_DIR = process.env.TEMP_DIR || './temp';

/**
 * Clean up all temp files for a user session
 */
async function cleanupSession(userId) {
  const session = SessionDB.getSession(userId);

  if (session) {
    // Remove archive file
    if (session.archive_path) {
      await fs.remove(session.archive_path).catch(() => {});
    }
    // Remove extraction directory
    if (session.extract_dir) {
      await fs.remove(session.extract_dir).catch(() => {});
    }
    // Remove user temp directory
    const userTempDir = path.join(TEMP_DIR, String(userId));
    await fs.remove(userTempDir).catch(() => {});
  }

  SessionDB.deleteSession(userId);
}

/**
 * Clean up old stale sessions (older than 1 hour)
 */
async function cleanupStaleSessions() {
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_PATH || './data/zipfy.db');

  try {
    const stale = db.prepare(`
      SELECT user_id, archive_path, extract_dir 
      FROM sessions 
      WHERE datetime(updated_at) < datetime('now', '-1 hour')
    `).all();

    for (const session of stale) {
      if (session.archive_path) await fs.remove(session.archive_path).catch(() => {});
      if (session.extract_dir)  await fs.remove(session.extract_dir).catch(() => {});
      const userTempDir = path.join(TEMP_DIR, String(session.user_id));
      await fs.remove(userTempDir).catch(() => {});
    }

    if (stale.length > 0) {
      db.prepare(`
        DELETE FROM sessions 
        WHERE datetime(updated_at) < datetime('now', '-1 hour')
      `).run();
      console.log(`🧹 Cleaned up ${stale.length} stale session(s)`);
    }
  } finally {
    db.close();
  }
}

/**
 * Get user temp directory path
 */
function getUserTempDir(userId) {
  return path.join(TEMP_DIR, String(userId));
}

module.exports = { cleanupSession, cleanupStaleSessions, getUserTempDir };
