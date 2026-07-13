// Multi-touch NURTURE for website-visitor leads.
//
// After a captured website visitor gets their first Skye outreach email, they're enrolled here.
// If they don't reply, they get up to MAX_TOUCHES AI-written follow-ups spaced GAP_DAYS apart
// (Day 3, Day 6 by default), each with a fresh angle — never a bare "just checking in". Any
// inbound message from them stops the sequence (markReplied). Sent through GHL (same stack as the
// first touch), keyed by GHL contactId, on its own Postgres table — separate from the cold
// outreach engine (outreach.js), which is Gmail-based and keyed by email.

const { getPool } = require("../db");
const { getContactInfo } = require("./contacts");
const { composeFollowup } = require("./openai");
const { setChannel, setEmailMeta, sendReplyHuman } = require("./ghl");

const GAP_DAYS = parseInt(process.env.NURTURE_GAP_DAYS || "3", 10);      // days between touches
const MAX_TOUCHES = parseInt(process.env.NURTURE_MAX_TOUCHES || "2", 10); // Day 3, Day 6

async function initNurture() {
  const db = getPool();
  if (!db) { console.warn("DATABASE_URL not set — nurture follow-ups disabled"); return; }
  await db.query(`
    CREATE TABLE IF NOT EXISTS nurture_leads (
      contact_id TEXT PRIMARY KEY,
      email TEXT,
      touch INT DEFAULT 0,
      status TEXT DEFAULT 'active',        -- active | replied | done
      location_id TEXT,
      enrolled_at TIMESTAMPTZ DEFAULT NOW(),
      last_sent_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  console.log("Nurture table ready");
}

// Enroll a lead — ONLY if the contact carries the `website-visitor` tag, so contact-form leads and
// others aren't pulled into this track. Called right after the first outreach email is sent.
async function maybeEnroll(contactId, locationId) {
  const db = getPool();
  if (!db || !contactId) return;
  try {
    const info = await getContactInfo(contactId).catch(() => null);
    const tags = ((info && info.tags) || []).map((t) => String(t).toLowerCase());
    if (!tags.includes("website-visitor")) return; // not a website-visitor capture — skip
    await db.query(
      `INSERT INTO nurture_leads (contact_id, email, location_id, status, touch, last_sent_at)
       VALUES ($1, $2, $3, 'active', 0, NOW())
       ON CONFLICT (contact_id) DO NOTHING`,
      [contactId, (info && info.email) || "", locationId || null]
    );
    console.log("Nurture enrolled website-visitor", contactId);
  } catch (e) { console.warn("Nurture enroll failed:", e.message); }
}

// Any inbound message from the lead stops the sequence.
async function markReplied(contactId) {
  const db = getPool();
  if (!db || !contactId) return;
  try {
    await db.query(`UPDATE nurture_leads SET status='replied' WHERE contact_id=$1 AND status='active'`, [contactId]);
  } catch (e) { /* non-fatal */ }
}

// Send any due follow-ups.
async function processNurture() {
  const db = getPool();
  if (!db) return;
  let rows = [];
  try {
    const r = await db.query(
      `SELECT contact_id, location_id, touch FROM nurture_leads
       WHERE status='active' AND touch < $1 AND last_sent_at < NOW() - ($2 || ' days')::interval
       ORDER BY last_sent_at ASC LIMIT 20`,
      [MAX_TOUCHES, String(GAP_DAYS)]
    );
    rows = r.rows;
  } catch (e) { console.warn("Nurture query failed:", e.message); return; }

  for (const lead of rows) {
    const contactId = lead.contact_id;
    try {
      const nextTouch = (lead.touch || 0) + 1;
      const email = await composeFollowup(contactId, nextTouch);
      if (!email || !process.env.GHL_API_KEY) continue;
      setChannel(contactId, "Email");
      setEmailMeta(contactId, { subject: "Following up from ScalePlus", isReply: false });
      await sendReplyHuman(contactId, email, lead.location_id);
      const newStatus = nextTouch >= MAX_TOUCHES ? "done" : "active";
      await db.query(
        `UPDATE nurture_leads SET touch=$1, status=$2, last_sent_at=NOW() WHERE contact_id=$3`,
        [nextTouch, newStatus, contactId]
      );
      console.log(`Nurture follow-up #${nextTouch} sent to ${contactId} (status=${newStatus})`);
    } catch (e) { console.error("Nurture send failed for", contactId, e.message); }
  }
}

let timer = null;
function startNurtureScheduler(intervalMs = 30 * 60 * 1000) {
  if (timer) return;
  timer = setInterval(() => { processNurture().catch((e) => console.error("processNurture error:", e.message)); }, intervalMs);
  console.log(`Nurture scheduler started (every ${Math.round(intervalMs / 60000)}m; ${GAP_DAYS}-day gap, ${MAX_TOUCHES} touches)`);
}

module.exports = { initNurture, maybeEnroll, markReplied, processNurture, startNurtureScheduler };
