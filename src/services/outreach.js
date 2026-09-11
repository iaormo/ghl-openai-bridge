// Cold-outreach engine. The upstream Claude scheduled task does the research and writes each
// bespoke Day-0 opener, then pushes a batch to POST /webhook/outreach/enqueue. This module owns
// the SENDING, under the rules from the 2026-09-11 deliverability audit:
//
//   * OFF unless OUTREACH_ENABLED=true. Fails closed.
//   * Nothing goes out below verification Level 1 (mailbox verified) or Level 2 (on the company's
//     own site + MX + catch-all). Level 2 is capped at 20% of a day's initial sends.
//   * One send at a time, on a random 4–11 minute gap. Never a batch loop. At most 6 per hour.
//   * Initial emails Mon–Thu, follow-ups Mon–Fri, 09:00–16:00 in the RECIPIENT's timezone.
//   * Day 0 → Day 4 → Day 10. Two follow-ups maximum, same thread, stop on reply / bounce / delay.
//   * Every send is checked against deliverability.canSend(): RED pauses outbound automatically.
//     YELLOW halves the daily cap. Bounces (DSNs) feed back through deliverability.processDsn().
//
// Env:
//   OUTREACH_ENABLED               "true" to send at all                     (default false)
//   OUTREACH_DAILY_LIMIT           max initial emails per day, hard cap 30   (default 5)
//   OUTREACH_FOLLOWUP_DAILY_LIMIT  max follow-ups per day, hard cap 30       (default 20)
//   OUTREACH_TZ                    timezone used for "today" in the daily caps (default Asia/Manila)
//   OUTREACH_DEFAULT_LEAD_TZ       recipient tz when the lead has none      (default America/New_York)
//   OUTREACH_ENQUEUE_KEY           shared secret the Claude task sends to authorize enqueue
// Sending reuses the Gmail OAuth already wired in gmail.js (same mailbox that answers replies).

const { getPool, getSetting, setSetting } = require("../db");
const gmail = require("./gmail");
const suppression = require("./suppression");
const deliverability = require("./deliverability");

const TZ = process.env.OUTREACH_TZ || "Asia/Manila";
const ENABLED = String(process.env.OUTREACH_ENABLED || "false").toLowerCase() === "true";
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, isNaN(n) ? lo : n));
const DAILY_LIMIT = clamp(parseInt(process.env.OUTREACH_DAILY_LIMIT || "5", 10), 1, 30);
const FOLLOWUP_DAILY_LIMIT = clamp(parseInt(process.env.OUTREACH_FOLLOWUP_DAILY_LIMIT || "20", 10), 1, 30);
const DEFAULT_LEAD_TZ = process.env.OUTREACH_DEFAULT_LEAD_TZ || "America/New_York";
const HOURLY_LIMIT = 6;
const GAP_MIN_MS = 4 * 60 * 1000;
const GAP_MAX_MS = 11 * 60 * 1000;
const FU_GAPS_DAYS = [4, 6];                 // stage 1 → +4d (Day 4), stage 2 → +6d (Day 10)
const MAX_FOLLOWUPS = FU_GAPS_DAYS.length;   // 3 touches total
const LEVEL2_SHARE = 0.2;
const LOCAL_START_HOUR = 9, LOCAL_END_HOUR = 16;
const INITIAL_DAYS = new Set([1, 2, 3, 4]);  // Mon–Thu
const FOLLOWUP_DAYS = new Set([1, 2, 3, 4, 5]); // Mon–Fri
const VERIFY_MAX_AGE_DAYS = 30;
const DEFAULT_SUBJECT = "where's my order?";

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
      status TEXT DEFAULT 'queued',   -- queued | sending | active | quarantined | bounced | replied | done | suppressed | rejected | frozen | error
      stage INT DEFAULT 0,            -- 0 none · 1 initial sent · 2 fu1 sent · 3 fu2 sent
      thread_id TEXT,
      message_id_header TEXT,
      last_sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  for (const col of [
    "linkedin TEXT", "winback_sent_at TIMESTAMP", "tz TEXT", "source TEXT", "source_url TEXT",
    "verify_level INT DEFAULT 0", "verify_status TEXT", "verified_at TIMESTAMP",
    "quarantined_at TIMESTAMP", "bounced_at TIMESTAMP", "replied_at TIMESTAMP", "initial_sent_at TIMESTAMP",
  ]) await db.query(`ALTER TABLE outreach_leads ADD COLUMN IF NOT EXISTS ${col}`);

  // Crash recovery: a lead claimed as 'sending' when the process died would otherwise be stranded.
  const stuck = await db.query(`UPDATE outreach_leads SET status = 'queued' WHERE status = 'sending' RETURNING id`);
  if (stuck.rowCount) console.log(`Outreach: requeued ${stuck.rowCount} lead(s) stuck mid-send`);

  // One-time freeze (2026-09-11 audit): the July sequences never completed and their list
  // contains addresses that have since hard-bounced. Nothing from before the new rules may send.
  if (!(await getSetting("outreach_freeze_2026_09_11"))) {
    const frozen = await db.query(`UPDATE outreach_leads SET status = 'frozen' WHERE status IN ('active','queued') RETURNING id`);
    await setSetting("outreach_freeze_2026_09_11", new Date().toISOString());
    console.log(`Outreach: froze ${frozen.rowCount} pre-audit lead(s) — they will not be sent or followed up`);
  }
  console.log(`Outreach: table ready (${ENABLED ? "ENABLED" : "DISABLED — set OUTREACH_ENABLED=true to send"}; ${DAILY_LIMIT} initial + ${FOLLOWUP_DAILY_LIMIT} follow-ups/day max)`);
}

// ---------- time helpers ----------

function partsIn(tz, date = new Date()) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" });
  } catch (_) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_LEAD_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" });
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24, weekday: wd };
}

function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch (_) { return DEFAULT_LEAD_TZ; }
}

// Is it a sensible moment to land in this recipient's inbox?
function inRecipientWindow(tz, kind) {
  const { hour, weekday } = partsIn(validTz(tz || DEFAULT_LEAD_TZ));
  const days = kind === "initial" ? INITIAL_DAYS : FOLLOWUP_DAYS;
  return days.has(weekday) && hour >= LOCAL_START_HOUR && hour < LOCAL_END_HOUR;
}

// Start of "today" in the outreach timezone, as an absolute Date (for the daily caps).
function startOfTodayUtc() {
  const { date } = partsIn(TZ);
  // Find the UTC instant at which local midnight happened: probe the offset at noon local.
  const probe = new Date(`${date}T12:00:00Z`);
  const local = partsIn(TZ, probe);
  const offsetHours = local.hour - 12; // e.g. Manila: 20 - 12 = +8
  return new Date(Date.parse(`${date}T00:00:00Z`) - offsetHours * 3600 * 1000);
}

const randGap = () => GAP_MIN_MS + Math.floor(Math.random() * (GAP_MAX_MS - GAP_MIN_MS));

// ---------- enqueue ----------

// Accept a batch of researched leads from the Claude task. Dedupes on email, drops anyone on the
// do-not-contact list, and verifies each address up front so the researcher sees what was refused.
// Payload fields: email, firstName, company, linkedin, subject, opener, tz (IANA), source
// ("official_site" | "verified" | "database" | "guess"), sourceUrl.
async function enqueueLeads(leads = []) {
  const db = getPool();
  if (!db) throw new Error("DB not configured");
  let added = 0, skipped = 0, suppressed = 0, rejected = 0;
  const rejections = [];
  for (const l of Array.isArray(leads) ? leads : []) {
    const email = l && (l.email || "").toString().trim().toLowerCase();
    const opener = l && (l.opener || "").toString().trim();
    if (!email || !opener) { skipped++; continue; }
    if (await suppression.isSuppressed(email)) {
      console.log(`Outreach: refused to enqueue ${email} — on the do-not-contact list`);
      suppressed++; continue;
    }
    const v = await deliverability.verifyEmail(email, { source: l.source || "" });
    const status = v.level >= 1 ? "queued" : "rejected";
    if (status === "rejected") { rejected++; rejections.push({ email, status: v.status, detail: v.detail }); }
    const r = await db.query(
      `INSERT INTO outreach_leads (email, first_name, company, linkedin, subject, opener, tz, source, source_url, verify_level, verify_status, verified_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12)
       ON CONFLICT (email) DO NOTHING`,
      [email, l.firstName || l.first_name || "", l.company || "", l.linkedin || "", l.subject || DEFAULT_SUBJECT, opener,
       validTz(l.tz || DEFAULT_LEAD_TZ), String(l.source || ""), String(l.sourceUrl || l.source_url || ""), v.level, v.status, status]
    );
    if (r.rowCount) { if (status === "queued") added++; } else skipped++;
  }
  return { added, skipped, suppressed, rejected, rejections };
}

// Verify without enqueueing — for the researcher to pre-check a list.
async function verifyBatch(leads = []) {
  const out = [];
  for (const l of Array.isArray(leads) ? leads : []) {
    const email = (typeof l === "string" ? l : l && l.email || "").toString().trim().toLowerCase();
    if (!email) continue;
    out.push({ email, ...(await deliverability.verifyEmail(email, { source: (l && l.source) || "" })) });
  }
  return out;
}

// ---------- the send loop: one email per tick, if the rules allow ----------

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try { await runTick(); } finally { ticking = false; }
}

let disabledLogged = false;
async function runTick() {
  const db = getPool();
  if (!db || !gmail.isConfigured()) return;
  await deliverability.releaseQuarantine();
  if (!ENABLED) {
    if (!disabledLogged) { console.log("Outreach: OUTREACH_ENABLED is not true — no cold email will be sent"); disabledLogged = true; }
    return;
  }
  const gate = await deliverability.canSend();
  if (!gate.ok) { console.log(`Outreach: blocked (${gate.status}): ${gate.reasons.join("; ")}`); return; }
  const halve = gate.status === "YELLOW";

  const nextAt = Date.parse((await getSetting("outreach_next_send_at")) || "") || 0;
  if (Date.now() < nextAt) return;

  const hour = await db.query(`SELECT COUNT(*)::int n FROM send_log WHERE sent_at > NOW() - INTERVAL '1 hour'`);
  if (hour.rows[0].n >= HOURLY_LIMIT) return;

  const override = parseInt((await getSetting("outreach_daily_limit_override")) || "", 10);
  let initialCap = isNaN(override) || override <= 0 ? DAILY_LIMIT : Math.min(DAILY_LIMIT, override);
  let followupCap = FOLLOWUP_DAILY_LIMIT;
  if (halve) { initialCap = Math.max(1, Math.floor(initialCap / 2)); followupCap = Math.max(1, Math.floor(followupCap / 2)); }

  const dayStart = startOfTodayUtc();
  const today = await db.query(
    `SELECT kind, verify_level, COUNT(*)::int n FROM send_log WHERE sent_at >= $1 GROUP BY kind, verify_level`, [dayStart]);
  const count = (kind, lvl) => today.rows.filter((r) => r.kind === kind && (lvl == null || r.verify_level === lvl)).reduce((a, r) => a + r.n, 0);
  const initialToday = count("initial"), followupToday = count("followup"), level2Today = count("initial", 2);

  // Follow-ups first: they go to people who already accepted one email from us.
  let sent = false;
  if (followupToday < followupCap) sent = await sendOneFollowup();
  if (!sent && initialToday < initialCap) sent = await sendOneInitial({ level2Allowed: (level2Today + 1) / (initialToday + 1) <= LEVEL2_SHARE });
  if (sent) await setSetting("outreach_next_send_at", new Date(Date.now() + randGap()).toISOString());
}

async function sendOneInitial({ level2Allowed }) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM outreach_leads WHERE status = 'queued' AND stage = 0 ORDER BY created_at ASC LIMIT 60`);
  for (const lead of rows) {
    if (!inRecipientWindow(lead.tz, "initial")) continue;
    if (lead.verify_level === 2 && !level2Allowed) continue;
    if (lead.verify_level < 1) { await db.query(`UPDATE outreach_leads SET status = 'rejected' WHERE id = $1`, [lead.id]); continue; }

    // Atomic claim before anything else, so no other pass (or replica) can pick the same lead.
    const claim = await db.query(
      `UPDATE outreach_leads SET status = 'sending' WHERE id = $1 AND status = 'queued' RETURNING id`, [lead.id]);
    if (!claim.rowCount) continue;
    try {
      // Last line of defence: opt-outs and domain suppressions that landed after enqueue.
      if (await suppression.isSuppressed(lead.email)) {
        await db.query(`UPDATE outreach_leads SET status = 'suppressed' WHERE id = $1`, [lead.id]);
        console.log(`Outreach: skipped ${lead.email} — on the do-not-contact list`);
        continue;
      }
      // Re-verify anything older than 30 days.
      let level = lead.verify_level;
      if (!lead.verified_at || Date.now() - new Date(lead.verified_at).getTime() > VERIFY_MAX_AGE_DAYS * 86400e3) {
        const v = await deliverability.verifyEmail(lead.email, { source: lead.source || "" });
        level = v.level;
        await db.query(`UPDATE outreach_leads SET verify_level = $1, verify_status = $2, verified_at = NOW() WHERE id = $3`, [v.level, v.status, lead.id]);
        if (level < 1) { await db.query(`UPDATE outreach_leads SET status = 'rejected' WHERE id = $1`, [lead.id]); console.log(`Outreach: ${lead.email} failed re-verification (${v.status})`); continue; }
        if (level === 2 && !level2Allowed) { await db.query(`UPDATE outreach_leads SET status = 'queued' WHERE id = $1`, [lead.id]); continue; }
      }
      const res = await gmail.sendNewEmail({
        toEmail: lead.email, toName: lead.first_name, subject: lead.subject || DEFAULT_SUBJECT, body: lead.opener,
      });
      await db.query(
        `UPDATE outreach_leads SET status = 'active', stage = 1, thread_id = $1, message_id_header = $2, last_sent_at = NOW(), initial_sent_at = NOW() WHERE id = $3`,
        [res.threadId, res.messageIdHeader, lead.id]);
      await deliverability.logSend({ leadId: lead.id, email: lead.email, kind: "initial", verifyLevel: level, threadId: res.threadId });
      console.log(`Outreach: initial sent to ${lead.email} (L${level}, ${lead.tz || DEFAULT_LEAD_TZ})`);
      return true;
    } catch (e) {
      console.error(`Outreach: initial send failed for ${lead.email}:`, e.message);
      await db.query(`UPDATE outreach_leads SET status = 'error' WHERE id = $1`, [lead.id]);
      return false;
    }
  }
  return false;
}

function followupBody(stage, first) {
  const name = first || "there";
  if (stage === 1) {
    return `Hi ${name},\n\nJust circling back on this. The nice part for Redline was they stopped having to keep an eye on it. It handled those 18,000 emails without a single one going wrong, so tracking pretty much looked after itself.\n\nIf it'd help take a bit off your team in the busy spells, I'm happy to walk you through it whenever suits.\n\nIan`;
  }
  return `Hi ${name},\n\nI'll leave it here so I'm not filling up your inbox. If tracking emails aren't much of a bother, honestly no worries.\n\nIf they are, I'd be glad to help you get it sorted. Just drop me a reply.\n\n(Not for you? Reply "remove" and I'll leave you be.)\n\nIan`;
}

async function sendOneFollowup() {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM outreach_leads WHERE status = 'active' AND stage BETWEEN 1 AND $1 ORDER BY last_sent_at ASC LIMIT 60`, [MAX_FOLLOWUPS]);
  for (const lead of rows) {
    const gapDays = FU_GAPS_DAYS[lead.stage - 1];
    if (!lead.last_sent_at || Date.now() - new Date(lead.last_sent_at).getTime() < gapDays * 86400e3) continue;
    if (!inRecipientWindow(lead.tz, "followup")) continue;

    // Atomic claim: bumping last_sent_at drops the row out of the due-window, so an overlapping
    // pass can't select and re-send the same follow-up.
    const claim = await db.query(
      `UPDATE outreach_leads SET last_sent_at = NOW() WHERE id = $1 AND status = 'active' AND last_sent_at < NOW() - ($2 || ' days')::interval RETURNING id`,
      [lead.id, gapDays]);
    if (!claim.rowCount) continue;
    try {
      if (await suppression.isSuppressed(lead.email)) {
        await db.query(`UPDATE outreach_leads SET status = 'suppressed' WHERE id = $1`, [lead.id]);
        console.log(`Outreach: ${lead.email} on the do-not-contact list — follow-ups stopped`);
        continue;
      }
      if (await gmail.threadHasExternalReply(lead.thread_id)) {
        await db.query(`UPDATE outreach_leads SET status = 'replied', replied_at = COALESCE(replied_at, NOW()) WHERE id = $1`, [lead.id]);
        console.log(`Outreach: ${lead.email} replied — follow-ups stopped`);
        continue;
      }
      const res = await gmail.sendThreadReply({
        toEmail: lead.email, toName: lead.first_name, subject: lead.subject || DEFAULT_SUBJECT,
        body: followupBody(lead.stage, lead.first_name),
        threadId: lead.thread_id, inReplyTo: lead.message_id_header, references: lead.message_id_header,
      });
      const nextStage = lead.stage + 1;
      const nextStatus = nextStage > MAX_FOLLOWUPS ? "done" : "active";
      await db.query(`UPDATE outreach_leads SET stage = $1, status = $2, last_sent_at = NOW() WHERE id = $3`, [nextStage, nextStatus, lead.id]);
      await deliverability.logSend({ leadId: lead.id, email: lead.email, kind: "followup", verifyLevel: lead.verify_level, threadId: res.threadId });
      console.log(`Outreach: follow-up #${lead.stage} sent to ${lead.email}${nextStatus === "done" ? " (sequence complete)" : ""}`);
      return true;
    } catch (e) {
      console.error(`Outreach: follow-up failed for ${lead.email}:`, e.message);
      return false;
    }
  }
  return false;
}

// Manual "send now": ignores the recipient window and the random gap, but nothing else — the
// health gate, verification, suppression, hourly and daily caps all still apply. One email.
async function sendDailyBatch(opts = {}) {
  if (!opts.force) return tick();
  if (!ENABLED) return { sent: false, reason: "OUTREACH_ENABLED is not true" };
  const gate = await deliverability.canSend();
  if (!gate.ok) return { sent: false, reason: gate.reasons.join("; ") };
  const sent = await sendOneInitial({ level2Allowed: false });
  return { sent };
}

// WINBACK stays OFF (OUTREACH_WINBACK_ENABLED). Retained for the record; per the audit each
// recipient gets at most 3 emails in 6 months and one sequence in 12, which a winback would break.
const WINBACK_ENABLED = String(process.env.OUTREACH_WINBACK_ENABLED || "false").toLowerCase() === "true";
async function processWinbacks() {
  if (WINBACK_ENABLED) console.warn("Outreach: winback is disabled by policy (max 3 emails per recipient in 6 months); ignoring OUTREACH_WINBACK_ENABLED");
}

// Snapshot for the status endpoint.
async function stats() {
  const db = getPool();
  if (!db) return { enabled: false };
  const q = await db.query(`SELECT status, COUNT(*)::int AS n FROM outreach_leads GROUP BY status`);
  const by = Object.fromEntries(q.rows.map((r) => [r.status, r.n]));
  const nextAt = await getSetting("outreach_next_send_at");
  const dayStart = startOfTodayUtc();
  const today = await db.query(`SELECT kind, COUNT(*)::int n FROM send_log WHERE sent_at >= $1 GROUP BY kind`, [dayStart]);
  return {
    enabled: ENABLED, tz: TZ, dailyLimit: DAILY_LIMIT, followupDailyLimit: FOLLOWUP_DAILY_LIMIT, hourlyLimit: HOURLY_LIMIT,
    gapMinutes: [GAP_MIN_MS / 60000, GAP_MAX_MS / 60000], followupDays: [0, ...FU_GAPS_DAYS.reduce((a, g) => [...a, (a[a.length - 1] || 0) + g], [])],
    window: `${LOCAL_START_HOUR}:00-${LOCAL_END_HOUR}:00 recipient local, Mon-Thu initial / Mon-Fri follow-up`,
    nextSendNotBefore: nextAt || null, sentToday: Object.fromEntries(today.rows.map((r) => [r.kind, r.n])),
    paused: await deliverability.pausedState(), byStatus: by,
  };
}

let started = false;
function startOutreachScheduler(intervalMs = 5 * 60 * 1000) {
  if (started) return;
  started = true;
  console.log(`Outreach scheduler started — ${ENABLED ? "enabled" : "DISABLED"}, one send per tick every ${intervalMs / 60000}min, ${GAP_MIN_MS / 60000}-${GAP_MAX_MS / 60000}min random gap, ≤${HOURLY_LIMIT}/h, ${DAILY_LIMIT} initial + ${FOLLOWUP_DAILY_LIMIT} follow-ups/day, Day 0/${FU_GAPS_DAYS[0]}/${FU_GAPS_DAYS[0] + FU_GAPS_DAYS[1]}`);
  setInterval(() => { tick().catch((e) => console.error("Outreach tick error:", e.message)); }, intervalMs);
}

module.exports = { initOutreach, enqueueLeads, verifyBatch, sendDailyBatch, processFollowups: sendOneFollowup, processWinbacks, stats, startOutreachScheduler, inRecipientWindow, partsIn, startOfTodayUtc };
