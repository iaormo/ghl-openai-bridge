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
    CREATE TABLE IF NOT EXISTS threads (
      id SERIAL PRIMARY KEY,
      contact_id TEXT UNIQUE NOT NULL,
      thread_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("Database initialized");
}

async function getThread(contactId) {
  const db = getPool();
  if (!db) return null;
  const result = await db.query(
    "SELECT thread_id FROM threads WHERE contact_id = $1",
    [contactId]
  );
  return result.rows[0]?.thread_id || null;
}

async function saveThread(contactId, threadId) {
  const db = getPool();
  if (!db) return;
  await db.query(
    "INSERT INTO threads (contact_id, thread_id) VALUES ($1, $2) ON CONFLICT (contact_id) DO UPDATE SET thread_id = $2",
    [contactId, threadId]
  );
}

module.exports = { getPool, initDB, getThread, saveThread };
