// Cold-outreach engine. The upstream Claude scheduled task does the research and writes each
// bespoke Day-0 opener, then pushes a batch to POST /webhook/outreach/enqueue. This module owns
// the SENDING: at OUTREACH_SEND_HOUR (Manila) it sends up to OUTREACH_DAILY_LIMIT initial emails
// from ian@scaleplus.io, then runs the Day 3 / 6 / 9 follow-ups, stopping the moment a lead replies.
//
// Env:
//   OUTREACH_TZ            timezone for the send window   (default Asia/Manila)
//   OUTREACH_SEND_HOUR     hour of day to send, 24h       (default 18 = 6pm)
//   OUTREACH_DAILY_LIMIT   max initial emails per day     (default 22)
//   OUTREACH_ENQUEUE_KEY   shared secret the Claude task sends to authorize enqueue
// Sending reuses the Gmail OAuth already wired in gmail.js (same mailbox that answers replies).

const { getPool, getSetting, setSetting } = require("../db");
const gmail = require("./gmail");

const TZ = process.env.OUTREACH_TZ || "Asia/Manila";
const SEND_HOUR = parseInt(process.env.OUTREACH_SEND_HOUR || "18", 10);
const DAILY_LIMIT = parseInt(process.env.OUTREACH_DAILY_LIMIT || "22", 10);
const FU_GAP_DAYS = 3;                       // 3 days between each touch → Day 0/3/6/9
const SEND_SPACING_MS = 90 * 1000;           // ~90s between sends: human pace + reputation
const DEFAULT_SUBJECT = "where's my order?";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function initOutreach() {
  const db = getPool();
  if (!db) { console.warn("Outreach: DATABASE_URL not set — outreach disabled"); return; }
  await db.query(`
    CREATE TABLE IF NOT EXISTS outreach_leads (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      first_name TEXT,
      company TEXT,
      linkedin TEXT,
      subject TEXT,
      opener TEXT NOT NULL,
      status TEXT DEFAULT 'queued',   -- queued | active | replied | done | error
      stage INT DEFAULT 0,            -- 0 none · 1 initial sent · 2 fu1 · 3 fu2 · 4 fu3
      thread_id TEXT,
      message_id_header TEXT,
      last_sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // idempotent: add linkedin column if an older table exists without it
  await db.query(`ALTER TABLE outreach_leads ADD COLUMN IF NOT EXISTS linkedin TEXT`);
  console.log("Outreach: table ready");
}

// Current { date: 'YYYY-MM-DD', hour } in the outreach timezone.
function nowParts() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) };
}

// Accept a batch of researched leads from the Claude task. Dedupes on email.
async function enqueueLeads(leads = []) {
  const db = getPool();
  if (!db) throw new Error("DB not configured");
  let added = 0, skipped = 0;
  for (const l of Array.isArray(leads) ? leads : []) {
    const email = l && (l.email || "").toString().trim().toLowerCase();
    const opener = l && (l.opener || "").toString().trim();
    if (!email || !opener) { skipped++; continue; }
    const r = await db.query(
      `INSERT INTO outreach_leads (email, first_name, company, linkedin, subject, opener)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO NOTHING`,
      [email, l.firstName || l.first_name || "", l.company || "", l.linkedin || "", l.subject || DEFAULT_SUBJECT, opener]
    );
    if (r.rowCount) added++; else skipped++;
  }
  return { added, skipped };
}

// The Day-0 body is the researched opener verbatim. Follow-ups reuse the approved templates.
function followupBody(stage, first) {
  const name = first || "there";
  if (stage === 1) {
    return `Hi ${name},\n\nJust circling back on this. The nice part for Redline was they stopped having to keep an eye on it. It handled those 18,000 emails without a single one going wrong, so tracking pretty much looked after itself.\n\nIf it'd help take a bit off your team in the busy spells, I'm happy to walk you through it whenever suits.\n\nIan`;
  }
  if (stage === 2) {
    return `Hi ${name},\n\nQuick one, out of interest, how many "where is it?" messages does your team get on a busy week? If it's a fair amount, this is the sort of thing that could quietly take care of most of them.\n\nNo worries at all if it's not really a thing for you.\n\nIan`;
  }
  return `Hi ${name},\n\nI'll leave it here so I'm not filling up your inbox. If tracking emails aren't much of a bother, honestly no worries.\n\nIf they are, I'd be glad to help you get it sorted. Just drop me a reply.\n\nIan`;
}

// Send today's initial batch — runs once per Manila day, at/after SEND_HOUR.
// Pass { force: true } to fire immediately (manual "send-now"), bypassing the hour/once-a-day gate.
async function sendDailyBatch(opts = {}) {
  const db = getPool();
  if (!db || !gmail.isConfigured()) return;
  const { date, hour } = nowParts();
  if (!opts.force) {
    if (hour < SEND_HOUR) return;
    if ((await getSetting("outreach_last_batch_date")) === date) return;
  }

  const { rows } = await db.query(
    `SELECT * FROM outreach_leads WHERE status = 'queued' AND stage = 0 ORDER BY created_at ASC LIMIT $1`,
    [DAILY_LIMIT]
  );
  if (!rows.length) { await setSetting("outreach_last_batch_date", date); return; }

  console.log(`Outreach: sending ${rows.length} initial email(s) — ${date} ${hour}:00 ${TZ}`);
  let sent = 0;
  for (const lead of rows) {
    try {
      const res = await gmail.sendNewEmail({
        toEmail: lead.email, toName: lead.first_name, subject: lead.subject || DEFAULT_SUBJECT, body: lead.opener,
      });
      await db.query(
        `UPDATE outreach_leads SET status = 'active', stage = 1, thread_id = $1, message_id_header = $2, last_sent_at = NOW() WHERE id = $3`,
        [res.threadId, res.messageIdHeader, lead.id]
      );
      sent++;
      await sleep(SEND_SPACING_MS);
    } catch (e) {
      console.error(`Outreach: initial send failed for ${lead.email}:`, e.message);
      await db.query(`UPDATE outreach_leads SET status = 'error' WHERE id = $1`, [lead.id]);
    }
  }
  await setSetting("outreach_last_batch_date", date);
  console.log(`Outreach: initial batch done — ${sent}/${rows.length} sent`);
}

// Send any due follow-ups (Day 3/6/9), skipping and closing out anyone who has replied.
async function processFollowups() {
  const db = getPool();
  if (!db || !gmail.isConfigured()) return;
  const { rows } = await db.query(
    `SELECT * FROM outreach_leads
     WHERE status = 'active' AND stage BETWEEN 1 AND 3
       AND last_sent_at < NOW() - ($1 || ' days')::interval`,
    [FU_GAP_DAYS]
  );
  for (const lead of rows) {
    try {
      if (await gmail.threadHasExternalReply(lead.thread_id)) {
        await db.query(`UPDATE outreach_leads SET status = 'replied' WHERE id = $1`, [lead.id]);
        console.log(`Outreach: ${lead.email} replied — follow-ups stopped`);
        continue;
      }
      await gmail.sendThreadReply({
        toEmail: lead.email, toName: lead.first_name, subject: lead.subject || DEFAULT_SUBJECT,
        body: followupBody(lead.stage, lead.first_name),
        threadId: lead.thread_id, inReplyTo: lead.message_id_header, references: lead.message_id_header,
      });
      const nextStage = lead.stage + 1;
      const nextStatus = nextStage > 4 ? "done" : "active";
      await db.query(`UPDATE outreach_leads SET stage = $1, status = $2, last_sent_at = NOW() WHERE id = $3`,
        [nextStage, nextStatus, lead.id]);
      console.log(`Outreach: follow-up #${lead.stage} sent to ${lead.email}`);
      await sleep(SEND_SPACING_MS);
    } catch (e) {
      console.error(`Outreach: follow-up failed for ${lead.email}:`, e.message);
    }
  }
}

// Snapshot for the status endpoint.
async function stats() {
  const db = getPool();
  if (!db) return { enabled: false };
  const q = await db.query(`SELECT status, COUNT(*)::int AS n FROM outreach_leads GROUP BY status`);
  const by = Object.fromEntries(q.rows.map((r) => [r.status, r.n]));
  return { enabled: true, sendHour: SEND_HOUR, tz: TZ, dailyLimit: DAILY_LIMIT, byStatus: by };
}

let started = false;
function startOutreachScheduler(intervalMs = 10 * 60 * 1000) {
  if (started) return;
  started = true;
  const tick = async () => {
    try { await sendDailyBatch(); } catch (e) { console.error("Outreach batch error:", e.message); }
    try { await processFollowups(); } catch (e) { console.error("Outreach follow-up error:", e.message); }
  };
  console.log(`Outreach scheduler started — send ${SEND_HOUR}:00 ${TZ}, up to ${DAILY_LIMIT}/day, follow-ups every ${FU_GAP_DAYS}d`);
  setInterval(tick, intervalMs);
  tick();
}

module.exports = { initOutreach, enqueueLeads, sendDailyBatch, processFollowups, stats, startOutreachScheduler };
