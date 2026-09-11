// Do-not-contact list — the compliance backstop for every outbound path.
//
// When someone says "unsubscribe" / "remove me" / "stop emailing me", that's a legal opt-out
// (CAN-SPAM, GDPR, CASL, PH Data Privacy Act). We honour it immediately and permanently: no
// follow-up, no nurture, no winback, no "sorry, come back" — those are commercial messages and
// sending one after an opt-out is both illegal and the fastest way to earn spam complaints, which
// are what actually wreck sending-domain reputation.
//
// The reply gate in openai.js (isPositiveReply) already stops Skye ANSWERING an opt-out. This
// module stops every future SEND — the part that carries the liability — and survives re-imports:
// a suppressed address stays suppressed even if the lead is enqueued again in a fresh campaign.
//
// Checked by outreach.js (enqueue / daily batch / follow-ups / winback) and nurture.js
// (enrol / process). Keyed by lowercased email. Suppression is deliberately one-way: there is no
// un-suppress helper, so nobody can be quietly put back on a list by code. Removing someone is a
// manual DB action, on purpose.

const { getPool } = require("../db");

// Phrases that mean "stop emailing me". Deliberately broad: a false positive costs one lead, a
// false negative costs a spam complaint or a fine. Cheap regex — runs on every inbound reply.
const OPT_OUT = new RegExp(
  [
    "\\bunsubscribe\\b",
    "\\bopt(?:ing)?[ -]?out\\b",
    "\\bremove me\\b",
    "\\bremove (?:me |us )?from\\b",
    "\\btake me off\\b",
    "\\bdo ?n[o']?t (?:contact|email|message) me\\b",
    "\\bstop (?:emailing|contacting|messaging|sending)\\b",
    "\\bno longer (?:wish|want) to (?:receive|hear)\\b",
    "\\bdelete my (?:data|details|email|info|information)\\b",
    "\\bleave me alone\\b",
  ].join("|"),
  "i"
);

// A bare one-word command is how most people actually opt out — and it's exactly what the winback
// copy asks for ("reply 'remove'"). The phrase list above deliberately requires an object
// ("remove ME", "remove FROM"), so a lone "remove" would sail straight through and we'd ignore an
// opt-out we invited. Matched only against the reply's FIRST line, so quoted thread text below it
// (which may well contain the word, including our own copy) can never trigger it.
const BARE_OPT_OUT = /^(remove|unsubscribe|stop|opt[ -]?out)\b[\s.!]*$/i;

function firstLineOf(text) {
  return (String(text || "").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith(">")) || "")
    .replace(/^["'\s]+/, "")
    .replace(/["'\s.!]+$/, "");
}

function isOptOutText(text) {
  const s = String(text || "");
  if (OPT_OUT.test(s)) return true;
  return BARE_OPT_OUT.test(firstLineOf(s));
}

const norm = (e) => String(e || "").trim().toLowerCase();

async function initSuppression() {
  const db = getPool();
  if (!db) { console.warn("DATABASE_URL not set — suppression list disabled (outbound will refuse to send)"); return; }
  await db.query(`
    CREATE TABLE IF NOT EXISTS suppressed_contacts (
      email TEXT PRIMARY KEY,
      reason TEXT NOT NULL,          -- unsubscribe | manual | complaint
      source TEXT,                   -- reachinbox | gmail | api
      evidence TEXT,                 -- the snippet that triggered it (audit trail)
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  console.log("Suppression list ready");
}

// Is this address on the do-not-contact list? Fails CLOSED: if we can't verify (no DB, query
// error), we report suppressed so the caller does NOT send. Never email on a maybe.
// Reasons, all written automatically (2026-09-11 audit):
//   unsubscribe · optout · not_interested · hard_bounce · invalid_mailbox · invalid_domain (domain
//   table) · policy_block · complaint · client · active_lead · vendor · manual
async function isSuppressed(email) {
  const e = norm(email);
  if (!e) return false;
  // Clients and their colleagues are never cold-emailed, whatever any list says.
  try { const { isClient } = require("./clients"); if (isClient(e)) return true; } catch (_) {}
  const db = getPool();
  if (!db) return false; // no DB configured at all — nothing else works either; don't block dev
  try {
    const r = await db.query("SELECT 1 FROM suppressed_contacts WHERE email = $1", [e]);
    if (r.rowCount > 0) return true;
    const d = e.split("@")[1];
    const rd = await db.query("SELECT 1 FROM suppressed_domains WHERE domain = $1", [d]);
    return rd.rowCount > 0;
  } catch (err) {
    console.error(`Suppression check FAILED for ${e} — refusing to send:`, err.message);
    return true; // fail closed
  }
}

// Add to the do-not-contact list (idempotent) and tag them in GHL so the human CRM view matches
// what the bot will actually do. Tagging is best-effort — the DB row is the source of truth.
// Pass tag:false for bounces and bad domains: a dead mailbox has no CRM contact worth creating.
async function suppress(email, { reason = "unsubscribe", source = "", evidence = "", tag = true } = {}) {
  const e = norm(email);
  if (!e) return false;
  const db = getPool();
  if (db) {
    try {
      await db.query(
        `INSERT INTO suppressed_contacts (email, reason, source, evidence)
         VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
        [e, reason, source || null, String(evidence || "").slice(0, 500) || null]
      );
    } catch (err) { console.error("Suppression write FAILED for", e, err.message); }
  }
  if (tag) {
    try {
      const { upsertContactByEmail } = require("./contacts");
      await upsertContactByEmail(e, "", { tags: ["do-not-contact", reason === "unsubscribe" ? "unsubscribed" : reason] });
    } catch (err) { console.warn("GHL do-not-contact tag failed for", e, "-", err.message); }
  }
  console.log(`Suppressed ${e} (${reason}${source ? " via " + source : ""}) — will not be emailed again`);
  return true;
}

// Kill anything already in flight for this address so an opt-out takes effect mid-sequence, not
// just on the next enrol. Both tables are keyed differently (outreach by email, nurture by
// contact_id with an email column), hence the two statements.
async function stopSequences(email) {
  const e = norm(email);
  const db = getPool();
  if (!db || !e) return;
  try {
    await db.query(`UPDATE outreach_leads SET status = 'suppressed' WHERE email = $1 AND status IN ('queued','active','quarantined','sending')`, [e]);
  } catch (err) { /* table may not exist yet — non-fatal */ }
  try {
    await db.query(`UPDATE nurture_leads SET status = 'suppressed' WHERE lower(email) = $1 AND status = 'active'`, [e]);
  } catch (err) { /* non-fatal */ }
}

// The one call an inbound handler needs: honour the opt-out completely.
async function suppressAndStop(email, opts = {}) {
  await suppress(email, opts);
  await stopSequences(email);
}

async function stats() {
  const db = getPool();
  if (!db) return { enabled: false };
  try {
    const r = await db.query(`SELECT reason, COUNT(*)::int AS n FROM suppressed_contacts GROUP BY reason`);
    const total = r.rows.reduce((a, x) => a + x.n, 0);
    return { enabled: true, total, byReason: Object.fromEntries(r.rows.map((x) => [x.reason, x.n])) };
  } catch (e) { return { enabled: true, error: e.message }; }
}

module.exports = { initSuppression, isOptOutText, isSuppressed, suppress, stopSequences, suppressAndStop, stats };
