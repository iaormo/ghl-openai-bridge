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
  console.log("Database initialized");
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

module.exports = { getPool, initDB, getHistory, saveMessage };
