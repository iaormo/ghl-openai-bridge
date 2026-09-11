// Deliverability guardrails for cold outreach — the part that protects scaleplus.io.
//
// Four jobs, all read by outreach.js before anything is sent:
//   1. verifyEmail()   — the Level 1 / Level 2 gate. Nothing is eligible below Level 1 unless it
//                        is on the company's own site AND the domain accepts mail (catch-all).
//                        Fails CLOSED: no verifier key → nothing is eligible.
//   2. processDsn()    — turns Gmail's "Delivery Status Notification" mail into bounce events,
//                        suppresses the address (or the whole domain when it does not exist), and
//                        quarantines leads on a temporary delay until Gmail gives a final answer.
//   3. health()        — the rolling-7-day dashboard: attempted, bounces, deferrals, opt-outs,
//                        replies, DNS state. GREEN / YELLOW / RED per the 2026-09-11 audit.
//   4. canSend()       — RED pauses outbound automatically. Resume is a deliberate, keyed action.
//
// Env:
//   ZEROBOUNCE_API_KEY       primary verifier (https://api.zerobounce.net/v2/validate)
//   NEVERBOUNCE_API_KEY      optional second opinion when ZeroBounce says "unknown"
//   OUTREACH_DOMAIN          sending domain to DNS-check (default scaleplus.io)

const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");
const { getPool, getSetting, setSetting } = require("../db");
const suppression = require("./suppression");

const SENDING_DOMAIN = process.env.OUTREACH_DOMAIN || "scaleplus.io";
const DAY = 24 * 60 * 60 * 1000;
const QUARANTINE_RELEASE_MS = 72 * 60 * 60 * 1000; // Gmail retries ~48h; 72h with no Failure = delivered

// Thresholds (rolling 7 days). Below MIN_SAMPLE sends the rates are noise, so absolute counts rule.
const T = {
  MIN_SAMPLE: 10,
  BOUNCE_YELLOW: 0.02, BOUNCE_RED: 0.04, BOUNCE_RED_DAY: 2,
  DELAY_YELLOW: 0.05, DELAY_RED: 0.10,
  OPTOUT_YELLOW: 0.02, OPTOUT_RED: 0.05,
  REPLY_MIN_SAMPLE_14D: 30, REPLY_YELLOW: 0.03, REPLY_RED: 0.01,
  SPAM_YELLOW: 0.0001, SPAM_RED: 0.001,
};

async function initDeliverability() {
  const db = getPool();
  if (!db) { console.warn("Deliverability: DATABASE_URL not set — guardrails disabled (outbound refuses to send)"); return; }
  await db.query(`
    CREATE TABLE IF NOT EXISTS delivery_events (
      id SERIAL PRIMARY KEY,
      email TEXT,
      kind TEXT NOT NULL,             -- failure | delay | policy | reputation
      code TEXT,                      -- e.g. 5.1.1
      diagnostic TEXT,
      message_id TEXT UNIQUE,         -- Gmail message id of the DSN (dedupe)
      thread_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS suppressed_domains (
      domain TEXT PRIMARY KEY,
      reason TEXT NOT NULL,           -- invalid_domain | client | vendor | manual
      evidence TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS send_log (
      id SERIAL PRIMARY KEY,
      lead_id INT,
      email TEXT NOT NULL,
      kind TEXT NOT NULL,             -- initial | followup
      verify_level INT,
      thread_id TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_send_log_sent_at ON send_log(sent_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_delivery_events_created ON delivery_events(created_at DESC)`);
  await seedSuppression();
  console.log("Deliverability: tables ready");
}

// One-time import of the bounces found in the 2026-09-11 audit. Idempotent (ON CONFLICT DO
// NOTHING) and gated by a settings flag so it never re-runs once applied.
async function seedSuppression() {
  const db = getPool();
  if (!db) return;
  const file = path.join(__dirname, "..", "..", "data", "suppression-seed.json");
  if (!fs.existsSync(file)) return;
  let seed;
  try { seed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.warn("Deliverability: seed unreadable:", e.message); return; }
  const flag = `suppression_seed_${seed.version || "v1"}`;
  if (await getSetting(flag)) return;
  let a = 0, d = 0;
  for (const row of seed.addresses || []) {
    const ok = await suppression.suppress(row.email, { reason: row.reason || "hard_bounce", source: "audit-seed", evidence: row.evidence || "", tag: false });
    if (ok) a++;
  }
  for (const row of seed.domains || []) {
    if (await suppressDomain(row.domain, { reason: row.reason || "invalid_domain", evidence: row.evidence || "" })) d++;
  }
  await setSetting(flag, new Date().toISOString());
  console.log(`Deliverability: seeded ${a} address(es) and ${d} domain(s) from the audit`);
}

// ---------- domain suppression ----------

const normDomain = (s) => String(s || "").trim().toLowerCase().replace(/^.*@/, "");

async function suppressDomain(domain, { reason = "manual", evidence = "" } = {}) {
  const d = normDomain(domain);
  const db = getPool();
  if (!d || !db) return false;
  try {
    await db.query(
      `INSERT INTO suppressed_domains (domain, reason, evidence) VALUES ($1, $2, $3) ON CONFLICT (domain) DO NOTHING`,
      [d, reason, String(evidence || "").slice(0, 500) || null]
    );
    return true;
  } catch (e) { console.error("Domain suppression write FAILED for", d, e.message); return false; }
}

// Fails closed like suppression.isSuppressed.
async function isDomainSuppressed(emailOrDomain) {
  const d = normDomain(emailOrDomain);
  const db = getPool();
  if (!d || !db) return false;
  try {
    const r = await db.query("SELECT 1 FROM suppressed_domains WHERE domain = $1", [d]);
    return r.rowCount > 0;
  } catch (e) { console.error("Domain suppression check FAILED — refusing:", e.message); return true; }
}

// ---------- verification ----------

const mxCache = new Map(); // domain -> { ok, at }
async function hasMx(domain) {
  const d = normDomain(domain);
  const hit = mxCache.get(d);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.ok;
  let ok = false;
  try { const mx = await dns.resolveMx(d); ok = Array.isArray(mx) && mx.length > 0; } catch (_) { ok = false; }
  mxCache.set(d, { ok, at: Date.now() });
  return ok;
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const ROLE_RE = /^(info|sales|office|hello|contact|admin|support|team|enquiries|inquiries|marketing)@/i;

async function zeroBounce(email) {
  const key = process.env.ZEROBOUNCE_API_KEY;
  if (!key) return null;
  const u = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&ip_address=`;
  const res = await fetch(u);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`ZeroBounce: ${data.error || res.status}`);
  return { status: String(data.status || "").toLowerCase(), sub: String(data.sub_status || "").toLowerCase(), raw: data };
}

async function neverBounce(email) {
  const key = process.env.NEVERBOUNCE_API_KEY;
  if (!key) return null;
  const u = `https://api.neverbounce.com/v4/single/check?key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`;
  const res = await fetch(u);
  const data = await res.json();
  if (!res.ok || data.status !== "success") throw new Error(`NeverBounce: ${data.message || res.status}`);
  return { status: String(data.result || "").toLowerCase(), raw: data };
}

// Returns { level, status, detail }. level 1 = mailbox verified, level 2 = official site + MX +
// catch-all, level 0 = not eligible. `source` is what the researcher tells us about where the
// address came from: "official_site" | "verified" | "database" | "guess" | "" .
async function verifyEmail(email, { source = "" } = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return { level: 0, status: "bad_syntax", detail: "" };
  const domain = e.split("@")[1];
  if (await suppression.isSuppressed(e)) return { level: 0, status: "suppressed", detail: "" };
  if (await isDomainSuppressed(domain)) return { level: 0, status: "suppressed_domain", detail: "" };
  if (!(await hasMx(domain))) {
    await suppressDomain(domain, { reason: "invalid_domain", evidence: "no MX record at verification" });
    return { level: 0, status: "no_mx", detail: "" };
  }
  if (String(source).toLowerCase() === "guess") return { level: 0, status: "pattern_guess", detail: "" };

  let zb;
  try { zb = await zeroBounce(e); } catch (err) { return { level: 0, status: "verifier_error", detail: err.message }; }
  if (!zb) return { level: 0, status: "no_verifier", detail: "ZEROBOUNCE_API_KEY not set — verification fails closed" };

  const official = String(source).toLowerCase() === "official_site";
  switch (zb.status) {
    case "valid":
      return { level: 1, status: "valid", detail: zb.sub };
    case "catch-all":
      if (official) return { level: 2, status: "catch_all_official", detail: zb.sub };
      return { level: 0, status: "catch_all_unpublished", detail: zb.sub };
    case "unknown": {
      // Second opinion, if available. Only a hard "valid" upgrades it.
      try {
        const nb = await neverBounce(e);
        if (nb && nb.status === "valid") return { level: 1, status: "valid_neverbounce", detail: "" };
        if (nb && nb.status === "catchall" && official) return { level: 2, status: "catch_all_official", detail: "neverbounce" };
      } catch (_) {}
      return { level: 0, status: "unknown", detail: zb.sub };
    }
    case "invalid":
    case "spamtrap":
    case "abuse":
    case "do_not_mail":
      await suppression.suppress(e, { reason: "invalid_mailbox", source: "zerobounce", evidence: `${zb.status} ${zb.sub}`, tag: false });
      return { level: 0, status: zb.status, detail: zb.sub };
    default:
      return { level: 0, status: zb.status || "unknown", detail: zb.sub };
  }
}

function isRoleAddress(email) { return ROLE_RE.test(String(email || "")); }

// ---------- DSN (bounce) processing ----------

const DSN_SENDER = /^(mailer-daemon|postmaster)@/i;
const DSN_SUBJECT = /delivery status notification|undeliverable|mail delivery failed|delivery incomplete|message not delivered|message blocked/i;

function looksLikeDsn(fromEmail, subject) {
  return DSN_SENDER.test(String(fromEmail || "")) || DSN_SUBJECT.test(String(subject || ""));
}

function parseDsn({ subject = "", body = "" }) {
  const text = String(body || "");
  let recipient = "";
  let m = text.match(/Final-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i) ||
          text.match(/(?:delivering your message to|wasn't delivered to|message to|delivered to)\s+<?([^\s<>]+@[^\s<>]+)>?/i) ||
          text.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  if (m) recipient = m[1].replace(/[.,;:]+$/, "").toLowerCase();

  let action = "";
  m = text.match(/Action:\s*(failed|delayed|delivered|relayed|expanded)/i);
  if (m) action = m[1].toLowerCase();
  else if (/\(failure\)|undeliverable|not delivered|message blocked|address not found|couldn't be delivered/i.test(subject + " " + text.slice(0, 400))) action = "failed";
  else if (/\(delay\)|delivery incomplete|temporary problem/i.test(subject + " " + text.slice(0, 400))) action = "delayed";

  let code = "";
  m = text.match(/\bStatus:\s*([245]\.\d{1,3}\.\d{1,3})/i) || text.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/);
  if (m) code = m[1];

  let diagnostic = "";
  m = text.match(/Diagnostic-Code:\s*(.+)/i) || text.match(/The response (?:from the remote server |from the recipient enterprise administrator )?was:\s*(.+)/i);
  if (m) diagnostic = m[1].trim().slice(0, 300);

  const domainMissing = /domain [^\s]+ couldn't be found|domain (?:does not|doesn't) exist|nxdomain|no such domain/i.test(text);
  const policy = /^5\.7\./.test(code) || /only accepts messages from|not authorized|blocked by policy|rejected/i.test(text);
  const reputation = /unsolicited|spam|reputation|blocked using|blacklist|rbl|421 4\.7\.0|support\.google\.com\/mail\/answer\/188131|mail\.google\.com\/support|security\.microsoft\.com/i.test(text);
  return { recipient, action, code, diagnostic, domainMissing, policy, reputation };
}

// Called by the Gmail poller for every DSN it sees. Idempotent on the DSN's Gmail message id.
async function processDsn({ subject, body, threadId, messageId, from }) {
  const db = getPool();
  if (!db) return null;
  const p = parseDsn({ subject, body });
  // Fall back to the outreach thread to find who we wrote to.
  if (!p.recipient && threadId) {
    const r = await db.query(`SELECT email FROM outreach_leads WHERE thread_id = $1`, [threadId]);
    if (r.rows[0]) p.recipient = r.rows[0].email;
  }
  if (!p.recipient) { console.log(`DSN: could not parse recipient (re "${subject}")`); return null; }

  const kind = p.reputation ? "reputation" : p.action === "delayed" ? "delay" : p.policy ? "policy" : "failure";
  const ins = await db.query(
    `INSERT INTO delivery_events (email, kind, code, diagnostic, message_id, thread_id)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (message_id) DO NOTHING RETURNING id`,
    [p.recipient, kind, p.code || null, p.diagnostic || null, messageId || null, threadId || null]
  );
  if (!ins.rowCount) return { duplicate: true, ...p, kind };

  if (kind === "delay") {
    await db.query(
      `UPDATE outreach_leads SET status = 'quarantined', quarantined_at = NOW()
       WHERE email = $1 AND status IN ('active','queued','sending')`, [p.recipient]);
    console.log(`DSN: ${p.recipient} deferred — quarantined until Gmail's final answer`);
  } else {
    const reason = kind === "policy" ? "policy_block" : "hard_bounce";
    await suppression.suppress(p.recipient, { reason, source: "gmail-dsn", evidence: `${p.code} ${p.diagnostic}`.trim(), tag: false });
    if (p.domainMissing) await suppressDomain(p.recipient.split("@")[1], { reason: "invalid_domain", evidence: p.diagnostic || "domain not found (DSN)" });
    await db.query(
      `UPDATE outreach_leads SET status = 'bounced', bounced_at = NOW()
       WHERE email = $1 AND status IN ('active','queued','sending','quarantined')`, [p.recipient]);
    console.log(`DSN: ${p.recipient} ${kind} (${p.code || "no code"}) — suppressed${p.domainMissing ? " + domain" : ""}`);
    if (kind === "reputation") await pause(`reputation signal in DSN for ${p.recipient}: ${p.diagnostic}`);
  }
  return { ...p, kind };
}

// Quarantined leads with no Failure after 72h are treated as delivered; the follow-up clock
// restarts from the day they were quarantined.
async function releaseQuarantine() {
  const db = getPool();
  if (!db) return 0;
  const r = await db.query(
    `UPDATE outreach_leads SET status = 'active', last_sent_at = quarantined_at
     WHERE status = 'quarantined' AND quarantined_at < NOW() - INTERVAL '72 hours' RETURNING email`);
  if (r.rowCount) console.log(`Deliverability: released ${r.rowCount} lead(s) from quarantine (no final failure in 72h)`);
  return r.rowCount;
}

// A human replied inside one of our outreach threads: stop the sequence, record the reply.
async function noteReply(threadId, fromEmail) {
  const db = getPool();
  if (!db || !threadId) return false;
  const r = await db.query(
    `UPDATE outreach_leads SET status = 'replied', replied_at = COALESCE(replied_at, NOW())
     WHERE thread_id = $1 AND status IN ('active','queued','quarantined','sending') RETURNING email`, [threadId]);
  if (r.rowCount) console.log(`Outreach: ${r.rows[0].email} replied (${fromEmail}) — sequence stopped`);
  return r.rowCount > 0;
}

// ---------- DNS self-check (cached 1h) ----------

let dnsCache = { at: 0, result: null };
async function checkDns() {
  if (dnsCache.result && Date.now() - dnsCache.at < 60 * 60 * 1000) return dnsCache.result;
  const out = { spf: "missing", spfCount: 0, dkim: "missing", dmarc: "missing", red: false, yellow: false };
  try {
    const txt = (await dns.resolveTxt(SENDING_DOMAIN)).map((a) => a.join(""));
    const spf = txt.filter((t) => /^v=spf1/i.test(t));
    out.spfCount = spf.length;
    out.spf = spf.length === 1 ? (/_spf\.google\.com/.test(spf[0]) ? "ok" : "changed") : spf.length ? "multiple" : "missing";
  } catch (_) {}
  try {
    const t = (await dns.resolveTxt(`google._domainkey.${SENDING_DOMAIN}`)).map((a) => a.join("")).join("");
    out.dkim = /v=DKIM1/i.test(t) && /p=[A-Za-z0-9+/]{100,}/.test(t) ? "ok" : "changed";
  } catch (_) {}
  try {
    const t = (await dns.resolveTxt(`_dmarc.${SENDING_DOMAIN}`)).map((a) => a.join("")).join("");
    out.dmarc = /p=(quarantine|reject)/i.test(t) ? "ok" : /v=DMARC1/i.test(t) ? "weak" : "missing";
  } catch (_) {}
  out.red = out.spf !== "ok" || out.dkim !== "ok" || out.dmarc === "missing";
  out.yellow = !out.red && out.dmarc === "weak";
  dnsCache = { at: Date.now(), result: out };
  return out;
}

// ---------- health + pause ----------

async function pause(reason) {
  await setSetting("outreach_paused", JSON.stringify({ at: new Date().toISOString(), reason: String(reason || "").slice(0, 500) }));
  console.error(`OUTREACH PAUSED: ${reason}`);
}

async function resume({ dailyLimit } = {}) {
  await setSetting("outreach_paused", "");
  await setSetting("outreach_resumed_at", new Date().toISOString());
  if (dailyLimit) await setSetting("outreach_daily_limit_override", String(parseInt(dailyLimit, 10)));
  else await setSetting("outreach_daily_limit_override", "");
}

async function pausedState() {
  const v = await getSetting("outreach_paused");
  if (!v) return null;
  try { return JSON.parse(v); } catch (_) { return { reason: v }; }
}

// Manual Postmaster figures (Google gives no API for the spam-rate dashboard). Recorded weekly
// via POST /webhook/outreach/postmaster and used for 7 days.
async function recordPostmaster({ spamRate, compliant }) {
  await setSetting("postmaster_report", JSON.stringify({ at: new Date().toISOString(), spamRate: Number(spamRate) || 0, compliant: compliant !== false }));
}

async function health() {
  const db = getPool();
  if (!db) return { status: "RED", reasons: ["no database"], metrics: {} };
  const q = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  const attempted7 = (await q(`SELECT COUNT(*)::int n FROM send_log WHERE sent_at > NOW() - INTERVAL '7 days'`)).n;
  const attempted14 = (await q(`SELECT COUNT(*)::int n FROM send_log WHERE sent_at > NOW() - INTERVAL '14 days'`)).n;
  const failures7 = (await q(`SELECT COUNT(DISTINCT email)::int n FROM delivery_events WHERE kind IN ('failure','policy') AND created_at > NOW() - INTERVAL '7 days'`)).n;
  const failuresToday = (await q(`SELECT COUNT(DISTINCT email)::int n FROM delivery_events WHERE kind IN ('failure','policy') AND created_at > NOW() - INTERVAL '1 day'`)).n;
  const delays7 = (await q(`SELECT COUNT(DISTINCT email)::int n FROM delivery_events WHERE kind = 'delay' AND created_at > NOW() - INTERVAL '7 days'`)).n;
  const reputation7 = (await q(`SELECT COUNT(*)::int n FROM delivery_events WHERE kind = 'reputation' AND created_at > NOW() - INTERVAL '7 days'`)).n;
  const optouts7 = (await q(`SELECT COUNT(*)::int n FROM suppressed_contacts WHERE reason IN ('unsubscribe','optout') AND created_at > NOW() - INTERVAL '7 days'`)).n;
  const replies14 = (await q(`SELECT COUNT(*)::int n FROM outreach_leads WHERE replied_at > NOW() - INTERVAL '14 days'`)).n;
  const openQuarantine = (await q(`SELECT COUNT(*)::int n FROM outreach_leads WHERE status = 'quarantined'`)).n;
  const dnsState = await checkDns();
  const paused = await pausedState();
  let postmaster = null;
  try { const v = await getSetting("postmaster_report"); postmaster = v ? JSON.parse(v) : null; } catch (_) {}
  if (postmaster && Date.now() - Date.parse(postmaster.at) > 7 * DAY) postmaster = null;

  const rate = (n, d) => (d > 0 ? n / d : 0);
  const bounceRate = rate(failures7, attempted7);
  const delayRate = rate(delays7, attempted7);
  const optoutRate = rate(optouts7, attempted7);
  const replyRate = rate(replies14, attempted14);
  const bigEnough = attempted7 >= T.MIN_SAMPLE;

  const red = [], yellow = [];
  if (paused) red.push(`paused: ${paused.reason}`);
  if (reputation7 > 0) red.push(`${reputation7} reputation/spam signal(s) in DSNs`);
  if (failuresToday >= T.BOUNCE_RED_DAY) red.push(`${failuresToday} hard bounces in the last 24h`);
  if (bigEnough && bounceRate > T.BOUNCE_RED) red.push(`hard bounce rate ${(bounceRate * 100).toFixed(1)}%`);
  else if ((bigEnough && bounceRate >= T.BOUNCE_YELLOW) || (!bigEnough && failures7 >= 1)) yellow.push(`hard bounces ${failures7}/${attempted7} in 7d`);
  if (bigEnough && delayRate > T.DELAY_RED) red.push(`deferral rate ${(delayRate * 100).toFixed(1)}%`);
  else if ((bigEnough && delayRate >= T.DELAY_YELLOW) || (!bigEnough && delays7 >= 2)) yellow.push(`deferrals ${delays7}/${attempted7} in 7d`);
  if (bigEnough && optoutRate > T.OPTOUT_RED) red.push(`opt-out rate ${(optoutRate * 100).toFixed(1)}%`);
  else if (bigEnough && optoutRate >= T.OPTOUT_YELLOW) yellow.push(`opt-outs ${optouts7}/${attempted7} in 7d`);
  if (attempted14 >= T.REPLY_MIN_SAMPLE_14D && replyRate < T.REPLY_YELLOW) yellow.push(`reply rate ${(replyRate * 100).toFixed(1)}% over 14d`);
  if (postmaster) {
    if (postmaster.spamRate >= T.SPAM_RED || postmaster.compliant === false) red.push(`Postmaster: spam ${postmaster.spamRate}${postmaster.compliant === false ? ", non-compliant" : ""}`);
    else if (postmaster.spamRate >= T.SPAM_YELLOW) yellow.push(`Postmaster spam rate ${postmaster.spamRate}`);
  } else yellow.push("no Postmaster figures recorded in the last 7 days");
  if (dnsState.red) red.push(`DNS: spf=${dnsState.spf}(${dnsState.spfCount}) dkim=${dnsState.dkim} dmarc=${dnsState.dmarc}`);
  else if (dnsState.yellow) yellow.push(`DNS: dmarc=${dnsState.dmarc}`);

  const status = red.length ? "RED" : yellow.length ? "YELLOW" : "GREEN";
  return {
    status, red, yellow, paused,
    metrics: {
      attempted7, attempted14, failures7, failuresToday, delays7, openQuarantine, reputation7, optouts7, replies14,
      bounceRate: +bounceRate.toFixed(4), delayRate: +delayRate.toFixed(4), optoutRate: +optoutRate.toFixed(4), replyRate: +replyRate.toFixed(4),
      dns: dnsState, postmaster,
    },
  };
}

// The gate outreach.js consults before every send. RED → pause (sticky) and refuse.
// YELLOW → allowed, but the caller halves its daily cap.
async function canSend() {
  const h = await health();
  if (h.status === "RED") {
    if (!h.paused) await pause(h.red.join("; "));
    return { ok: false, status: "RED", reasons: h.red, health: h };
  }
  return { ok: true, status: h.status, reasons: h.yellow, health: h };
}

async function logSend({ leadId, email, kind, verifyLevel, threadId }) {
  const db = getPool();
  if (!db) return;
  await db.query(
    `INSERT INTO send_log (lead_id, email, kind, verify_level, thread_id) VALUES ($1, $2, $3, $4, $5)`,
    [leadId || null, email, kind, verifyLevel || null, threadId || null]
  );
}

module.exports = {
  initDeliverability, verifyEmail, isRoleAddress, hasMx,
  suppressDomain, isDomainSuppressed,
  looksLikeDsn, parseDsn, processDsn, releaseQuarantine, noteReply,
  checkDns, health, canSend, pause, resume, pausedState, recordPostmaster, logSend,
  THRESHOLDS: T,
};
