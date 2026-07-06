const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

async function initDB() {
  const db = getPool();
  if (!db) {
    console.warn("DATABASE_URL not set — skipping DB init");
    return;
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      contact_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, created_at DESC)
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("Database initialized");
}

// Persist a small key/value setting (e.g. the Gmail refresh token)
async function setSetting(key, value) {
  const db = getPool();
  if (!db) return;
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

async function getSetting(key) {
  const db = getPool();
  if (!db) return null;
  const r = await db.query("SELECT value FROM settings WHERE key = $1", [key]);
  return r.rows[0] ? r.rows[0].value : null;
}

// Get last N messages for a contact (for conversation context)
async function getHistory(contactId, limit = 20) {
  const db = getPool();
  if (!db) return [];
  const result = await db.query(
    `SELECT role, content FROM messages
     WHERE contact_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [contactId, limit]
  );
  return result.rows.reverse(); // oldest first
}

// Save a message (user or assistant)
async function saveMessage(contactId, role, content) {
  const db = getPool();
  if (!db) return;
  await db.query(
    "INSERT INTO messages (contact_id, role, content) VALUES ($1, $2, $3)",
    [contactId, role, content]
  );
}

// Delete all stored conversation history for a contact (reset the bot's memory of them).
async function deleteHistory(contactId) {
  const db = getPool();
  if (!db) return { deleted: 0 };
  const result = await db.query("DELETE FROM messages WHERE contact_id = $1", [contactId]);
  return { deleted: result.rowCount };
}

module.exports = { getPool, initDB, getHistory, saveMessage, deleteHistory, setSetting, getSetting };
