import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function initDb() {
  const db = await open({
    filename: path.join(__dirname, 'agent_memory.sqlite'),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT,
      mimeType TEXT,
      modifiedTime TEXT,
      summary TEXT,
      tags TEXT,
      value_score INTEGER,
      category TEXT DEFAULT 'Uncategorized',
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      action TEXT,
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS memory (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT,
      refresh_token TEXT,
      scope TEXT,
      token_type TEXT,
      expiry_date INTEGER
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT,
      content TEXT,
      embedding BLOB,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reorganization_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT,
      original_path TEXT,
      suggested_path TEXT,
      reason TEXT,
      status TEXT DEFAULT 'PENDING'
    );
  `);

  // Migration: add 'category' column if it doesn't exist yet (for existing DBs)
  try {
    await db.run(`ALTER TABLE files ADD COLUMN category TEXT DEFAULT 'Uncategorized'`);
    console.log('[DB] Migrated: added category column to files table.');
  } catch (e) {
    // Column already exists — ignore
  }

  return db;
}
