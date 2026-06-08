const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs-extra');

const DB_PATH = process.env.DB_PATH || './data/zipfy.db';

// Ensure data directory exists
fs.ensureDirSync(path.dirname(DB_PATH));

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    user_id     INTEGER PRIMARY KEY,
    state       TEXT NOT NULL DEFAULT 'idle',
    archive_path TEXT,
    extract_dir  TEXT,
    file_list   TEXT,
    total_files  INTEGER DEFAULT 0,
    sent_files   INTEGER DEFAULT 0,
    password     TEXT,
    original_name TEXT,
    archive_type TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    action      TEXT,
    file_name   TEXT,
    file_count  INTEGER,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const SessionDB = {
  // Get session for a user
  getSession(userId) {
    const row = db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(userId);
    if (!row) return null;
    return {
      ...row,
      file_list: row.file_list ? JSON.parse(row.file_list) : []
    };
  },

  // Create or reset session
  upsertSession(userId, data = {}) {
    const existing = db.prepare('SELECT user_id FROM sessions WHERE user_id = ?').get(userId);
    if (existing) {
      const fields = Object.keys(data).map(k => `${k} = ?`).join(', ');
      const values = Object.values(data).map(v =>
        typeof v === 'object' && v !== null ? JSON.stringify(v) : v
      );
      db.prepare(`UPDATE sessions SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`)
        .run(...values, userId);
    } else {
      const processedData = { user_id: userId, ...data };
      Object.keys(processedData).forEach(k => {
        if (typeof processedData[k] === 'object' && processedData[k] !== null) {
          processedData[k] = JSON.stringify(processedData[k]);
        }
      });
      const cols = Object.keys(processedData).join(', ');
      const placeholders = Object.keys(processedData).map(() => '?').join(', ');
      db.prepare(`INSERT INTO sessions (${cols}) VALUES (${placeholders})`)
        .run(...Object.values(processedData));
    }
  },

  // Update specific fields
  updateSession(userId, data) {
    const processed = {};
    Object.keys(data).forEach(k => {
      processed[k] = typeof data[k] === 'object' && data[k] !== null
        ? JSON.stringify(data[k])
        : data[k];
    });
    const fields = Object.keys(processed).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE sessions SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`)
      .run(...Object.values(processed), userId);
  },

  // Delete session
  deleteSession(userId) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  },

  // Log stats
  logStat(userId, action, fileName = null, fileCount = 0) {
    db.prepare('INSERT INTO stats (user_id, action, file_name, file_count) VALUES (?, ?, ?, ?)')
      .run(userId, action, fileName, fileCount);
  },

  // Get global stats
  getStats() {
    return {
      totalUsers: db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM stats').get().c,
      totalExtractions: db.prepare("SELECT COUNT(*) as c FROM stats WHERE action = 'extract_success'").get().c,
      totalFiles: db.prepare("SELECT SUM(file_count) as c FROM stats WHERE action = 'extract_success'").get().c || 0
    };
  }
};

module.exports = SessionDB;
