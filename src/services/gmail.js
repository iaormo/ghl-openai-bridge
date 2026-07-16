// Direct Gmail integration — the bot reads inbound emails in a scoped Gmail label and replies
// from that mailbox (properly threaded), independent of GHL. Auth is OAuth2 (refresh token).
//
// Env:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET   — Google Cloud OAuth client
//   GMAIL_REDIRECT_URI                      — OAuth callback (default: <host>/oauth/gmail/callback)
//   GMAIL_USER                              — the mailbox address (e.g. ian@scaleplus.io)
//   GMAIL_FROM_NAME                         — display name (default: "Ian from ScalePlus")
//   GMAIL_LABEL                             — ONLY emails with this Gmail label are answered (scoping)
//   GMAIL_REFRESH_TOKEN                     — optional; otherwise read from the DB settings store

const { getSetting, setSetting } = require("../db");
const { chat, isValidInquiry } = require("./openai");
const { upsertContactByEmail } = require("./contacts");
const { classify, clientContext, isClient } = require("./clients");
const { stripMarkdown } = require("./ghl");
const suppression = require("./suppression");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

function cfg() {
  return {
    clientId: process.env.GMAIL_CLIENT_ID || "",
    clientSecret: process.env.GMAIL_CLIENT_SECRET || "",
    redirectUri: process.env.GMAIL_REDIRECT_URI || "https://skye-production.up.railway.app/oauth/gmail/callback",
    user: process.env.GMAIL_USER || "",
    fromName: process.env.GMAIL_FROM_NAME || "Ian from ScalePlus",
    label: process.env.GMAIL_LABEL || "",
  };
}

function isConfigured() {
  const c = cfg();
  return !!(c.clientId && c.clientSecret && c.label);
}

// ---------- OAuth ----------

function consentUrl() {
  const c = cfg();
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${p.toString()}`;
}

// Exchange an auth code for a refresh token and persist it.
async function exchangeCode(code) {
  const c = cfg();
  const body = new URLSearchParams({
    code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: c.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(data).slice(0, 300)}`);
  }
  await setSetting("gmail_refresh_token", data.refresh_token);
  return true;
}

let accessTokenCache = { token: null, exp: 0 };

async function getAccessToken() {
  if (accessTokenCache.token && Date.now() < accessTokenCache.exp - 30000) {
    return accessTokenCache.token;
  }
  const c = cfg();
  const refresh = process.env.GMAIL_REFRESH_TOKEN || (await getSetting("gmail_refresh_token"));
  if (!refresh) throw new Error("No Gmail refresh token — visit /oauth/gmail/start to connect");
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data).slice(0, 200)}`);
  accessTokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function gapi(path, opts = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gmail API ${path} (${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// ---------- helpers ----------

const b64urlEncode = (str) => Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (str) => Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function getHeader(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

// Recursively pull the best text body (prefer text/plain) from a Gmail payload.
function extractBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body && payload.body.data) return b64urlDecode(payload.body.data);
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = extractBody(p);
      if (t) return t;
    }
  }
  if (payload.mimeType === "text/html" && payload.body && payload.body.data) {
    return b64urlDecode(payload.body.data).replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n");
  }
  return "";
}

// Parse the sender's email out of a "Name <email>" From header.
function parseEmail(from) {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

// Build a raw RFC-822 reply (with quoted original) and base64url-encode it.
function buildRawReply({ toEmail, toName, fromName, fromEmail, subject, inReplyTo, references, replyBody, originalBody, originalFrom, originalDate }) {
  const subj = /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
  let body = replyBody;
  if (originalBody) {
    const when = originalDate || "";
    const header = `On ${when}, ${originalFrom || "they"} wrote:`.replace(/^On , /, "On ");
    body += `\n\n${header}\n` + String(originalBody).trim().split("\n").map((l) => `> ${l}`).join("\n");
  }
  const headers = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${toName ? `${toName} <${toEmail}>` : toEmail}`,
    `Subject: ${subj}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
    references ? `References: ${references}` : inReplyTo ? `References: ${inReplyTo}` : "",
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
  ].filter(Boolean);
  return b64urlEncode(headers.join("\r\n") + "\r\n\r\n" + body);
}

// ---------- poll + reply ----------

async function getLabelId(name) {
  const data = await gapi("/labels");
  const lbl = (data.labels || []).find((l) => l.name.toLowerCase() === name.toLowerCase());
  return lbl ? lbl.id : null;
}

async function getOrCreateLabel(name) {
  const existing = await getLabelId(name);
  if (existing) return existing;
  const created = await gapi("/labels", {
    method: "POST",
    body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  return created.id;
}

const AUTOMATED = /(noreply|no-reply|mailer-daemon|postmaster|notifications?@|donotreply|do-not-reply|bounce)/i;

// Reply to each real email carrying the trigger label — whether you tagged it by hand or a
// filter applied it. Handled emails lose the trigger label (and successful replies are filed
// under "<label>/Replied") so nothing is ever answered twice.
// Re-entrancy guard. The poller ticks every 60s, but a single pass can take far longer than that
// (up to 20 messages, each an OpenAI call + a Gmail send). A message isn't labelled Seen/Replied
// until AFTER it's handled, so an overlapping pass would re-list the same unread mail and answer it
// a second time. That's the "Skye replied twice" bug — one pass at a time, always.
let polling = false;
async function pollAndReply() {
  if (polling) { console.log("Gmail: previous poll still running — skipping this tick"); return; }
  polling = true;
  try { return await runPoll(); } finally { polling = false; }
}

async function runPoll() {
  if (!isConfigured()) return;
  const c = cfg();
  let labelId;
  try { labelId = await getLabelId(c.label); } catch (e) { console.warn("Gmail label lookup failed:", e.message); return; }
  if (!labelId) { console.warn(`Gmail label "${c.label}" not found — create it in Gmail; Skye answers anything you tag with it`); return; }
  const repliedId = await getOrCreateLabel(`${c.label}/Replied`).catch(() => null);
  const seenId = await getOrCreateLabel(`${c.label}/Seen`).catch(() => null);

  // Two sources of work: (1) mail you tagged with the label by hand — always answered (force
  // override); (2) recent unread INBOX mail — the "reply to every human with a real query" flow.
  // The newer_than window + /Replied and /Seen labels keep this off the old backlog; warmup /
  // cold-outreach that skips the inbox never appears here.
  const work = new Map(); // id -> { manual }
  try {
    const tagged = await gapi(`/messages?labelIds=${labelId}&maxResults=10`);
    for (const m of tagged.messages || []) work.set(m.id, { manual: true });
  } catch (e) { console.warn("Gmail label list failed:", e.message); }
  try {
    const q = encodeURIComponent(`in:inbox is:unread newer_than:2d -label:${c.label}/Seen -label:${c.label}/Replied`);
    const inbox = await gapi(`/messages?q=${q}&maxResults=10`);
    for (const m of inbox.messages || []) if (!work.has(m.id)) work.set(m.id, { manual: false });
  } catch (e) { console.warn("Gmail inbox list failed:", e.message); }
  if (!work.size) return;

  for (const id of work.keys()) {
    try {
      const msg = await gapi(`/messages/${id}?format=full`);
      const headers = msg.payload && msg.payload.headers;
      const from = getHeader(headers, "From");
      const fromEmail = parseEmail(from);
      const subject = getHeader(headers, "Subject") || "(no subject)";
      const messageId = getHeader(headers, "Message-ID");
      const references = getHeader(headers, "References");
      const date = getHeader(headers, "Date");
      const body = extractBody(msg.payload).trim();

      // Skip marker = drop the trigger label, tag "<label>/Seen" so it's not reprocessed, but
      // LEAVE it unread — a skipped email you might still care about is never silently marked read.
      const seen = () => gapi(`/messages/${id}/modify`, {
        method: "POST",
        body: JSON.stringify({ removeLabelIds: [labelId], addLabelIds: seenId ? [seenId] : [] }),
      });
      // Replied = drop the trigger label, mark read, and file under "<label>/Replied".
      const markReplied = () => gapi(`/messages/${id}/modify`, {
        method: "POST",
        body: JSON.stringify({ removeLabelIds: [labelId, "UNREAD"], addLabelIds: repliedId ? [repliedId] : [] }),
      });

      // Never auto-reply to ourselves or a teammate on our own domain.
      const ourDomain = (c.user.split("@")[1] || "").toLowerCase();
      const senderDomain = (fromEmail.split("@")[1] || "").toLowerCase();
      if (!body || fromEmail === c.user.toLowerCase() || (ourDomain && senderDomain === ourDomain)) {
        await seen();
        continue;
      }

      // ReachInbox / email-warmup traffic uses codename display names like "Friendly-Turtle",
      // "Vicious-Gnat", "Happy-Otter" (Capitalized Adjective-Animal, hyphenated). It's built to
      // look human, so it slips past the "valid query" gate — never reply to it (replying pollutes
      // your warmup network). Clients are exempt just in case.
      const displayName = from.replace(/<[^>]+>/, "").replace(/["']/g, "").trim();
      if (!isClient(fromEmail) && /^[A-Z][a-z]+-[A-Z][a-z]+$/.test(displayName)) {
        console.log(`Gmail: skipped ${fromEmail} — warmup sender "${displayName}"`);
        await seen();
        continue;
      }

      // "Came from a human?" — a no-reply address, mailing list, marketing blast, or an
      // auto-generated message all count as automated and get skipped.
      const bulk =
        getHeader(headers, "List-Unsubscribe") ||
        getHeader(headers, "List-Id") ||
        /\b(bulk|list|junk|auto_reply)\b/i.test(getHeader(headers, "Precedence")) ||
        /auto-(generated|replied|notified)/i.test(getHeader(headers, "Auto-Submitted"));
      const automated = AUTOMATED.test(from) || !!bulk;

      // An explicit opt-out from a REAL PERSON ("unsubscribe", "remove me", "stop emailing me") is
      // a legal instruction: do-not-contact them permanently, kill any sequence they're in, and
      // never reply — an apology or winback after an opt-out is still a commercial message.
      //
      // Deliberately placed AFTER the warmup + bulk/automated gates: every newsletter and marketing
      // blast carries "unsubscribe" in its footer, so checking earlier would suppress (and create a
      // GHL contact for) every newsletter sender and pollute the warmup network. A genuine human
      // opt-out reply carries no List-Unsubscribe/List-Id header, so it still lands here.
      if (!automated && (suppression.isOptOutText(body) || suppression.isOptOutText(subject))) {
        await suppression.suppressAndStop(fromEmail, {
          reason: "unsubscribe", source: "gmail", evidence: `${subject} — ${body.slice(0, 200)}`,
        });
        console.log(`Gmail: ${fromEmail} opted out — suppressed, no reply sent`);
        await seen();
        continue;
      }

      // clients.md policy: clients are always answered; excluded domains and
      // PO/tracking/support subjects are skipped (unless the sender is a client).
      const decision = classify({ fromEmail, subject, automated });
      if (!decision.reply) {
        console.log(`Gmail: skipped ${fromEmail} — ${decision.reason} (re "${subject}")`);
        await seen();
        continue;
      }

      // For non-clients, only reply when there's a genuine query — this keeps Skye out of
      // warmup/cold-outreach filler and pleasantries when the label is applied broadly. Clients
      // (from clients.md) are always answered, so they skip this gate.
      if (!isClient(fromEmail) && !(await isValidInquiry(subject, body))) {
        console.log(`Gmail: skipped ${fromEmail} — no valid query (re "${subject}")`);
        await seen();
        continue;
      }

      // Contact in GHL so booking/notes/memory work, then generate the reply as Email
      let contactId = null;
      try { contactId = await upsertContactByEmail(fromEmail, from); } catch (e) { console.warn("Gmail contact upsert failed:", e.message); }
      const clientCtx = clientContext(fromEmail);
      const reply = stripMarkdown(await chat(contactId || `gmail:${fromEmail}`, body, "Email", clientCtx));

      const raw = buildRawReply({
        toEmail: fromEmail,
        toName: from.replace(/<[^>]+>/, "").replace(/"/g, "").trim(),
        fromName: c.fromName,
        fromEmail: c.user,
        subject,
        inReplyTo: messageId,
        references: (references ? references + " " : "") + messageId,
        replyBody: reply,
        originalBody: body,
        originalFrom: from,
        originalDate: date,
      });
      await gapi("/messages/send", { method: "POST", body: JSON.stringify({ raw, threadId: msg.threadId }) });
      await markReplied();
      console.log(`Gmail: replied to ${fromEmail} re "${subject}"`);
    } catch (e) {
      console.error(`Gmail: failed to handle message ${id}:`, e.message);
    }
  }
}

// DRY RUN: show what the poller WOULD do with current unread inbox mail — runs the exact same
// gates (self/team, automated, clients.md, valid-query) but sends NOTHING and changes no labels.
// For verification via `railway run` against production credentials.
async function inspectInbox() {
  if (!isConfigured()) { console.log("Gmail not configured"); return; }
  const c = cfg();
  const ourDomain = (c.user.split("@")[1] || "").toLowerCase();
  const q = encodeURIComponent("in:inbox is:unread newer_than:2d");
  const list = await gapi(`/messages?q=${q}&maxResults=8`);
  const ids = (list.messages || []).map((m) => m.id);
  console.log(`\nUnread inbox mail (last 2 days): ${ids.length} message(s)\n`);
  const results = [];
  for (const id of ids) {
    const msg = await gapi(`/messages/${id}?format=full`);
    const headers = msg.payload && msg.payload.headers;
    const from = getHeader(headers, "From");
    const fromEmail = parseEmail(from);
    const subject = getHeader(headers, "Subject") || "(no subject)";
    const body = extractBody(msg.payload).trim();
    const senderDomain = (fromEmail.split("@")[1] || "").toLowerCase();
    const bulk = getHeader(headers, "List-Unsubscribe") || getHeader(headers, "List-Id") ||
      /\b(bulk|list|junk|auto_reply)\b/i.test(getHeader(headers, "Precedence")) ||
      /auto-(generated|replied|notified)/i.test(getHeader(headers, "Auto-Submitted"));
    const automated = AUTOMATED.test(from) || !!bulk;
    let verdict = "REPLY", reason;
    if (!body || fromEmail === c.user.toLowerCase() || (ourDomain && senderDomain === ourDomain)) {
      verdict = "SKIP"; reason = "self/team/empty";
    } else {
      const d = classify({ fromEmail, subject, automated });
      if (!d.reply) { verdict = "SKIP"; reason = d.reason; }
      else if (!isClient(fromEmail) && !(await isValidInquiry(subject, body))) { verdict = "SKIP"; reason = "no valid query"; }
      else { reason = isClient(fromEmail) ? "client (always reply)" : "valid query"; }
    }
    console.log(`  [${verdict}] ${fromEmail} — "${subject.slice(0, 55)}"  → ${reason}`);
    results.push({ verdict, from: fromEmail, subject: subject.slice(0, 80), reason });
  }
  console.log("");
  return { count: ids.length, results };
}

// One-shot recovery: strip the "/Seen" marker from recent unread inbox mail so the poller takes
// another look (used to recover mail an over-eager cutoff had skipped). Returns how many cleared.
async function reprocessInbox() {
  if (!isConfigured()) return { cleared: 0 };
  const c = cfg();
  const seenId = await getLabelId(`${c.label}/Seen`);
  if (!seenId) return { cleared: 0 };
  const q = encodeURIComponent(`in:inbox is:unread newer_than:3d label:${c.label}/Seen`);
  const list = await gapi(`/messages?q=${q}&maxResults=25`);
  const ids = (list.messages || []).map((m) => m.id);
  for (const id of ids) {
    await gapi(`/messages/${id}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: [seenId] }) });
  }
  console.log(`Gmail reprocess: cleared /Seen from ${ids.length} inbox message(s) for another look`);
  return { cleared: ids.length };
}

// Start the background poller (every intervalMs) if Gmail is configured.
function startGmailPoller(intervalMs = 60000) {
  if (!isConfigured()) {
    console.log("Gmail poller not started (GMAIL_CLIENT_ID/SECRET/LABEL not set)");
    return;
  }
  console.log(`Gmail poller started — watching label "${cfg().label}" every ${intervalMs / 1000}s`);
  setInterval(() => { pollAndReply().catch((e) => console.error("Gmail poll error:", e.message)); }, intervalMs);
}

// ---------- outbound cold send (used by the outreach scheduler) ----------

// Send a brand-new email (new thread) from the configured mailbox. Returns { id, threadId,
// messageIdHeader } — the Message-ID is captured so follow-ups can thread as proper replies.
async function sendNewEmail({ toEmail, toName, subject, body }) {
  const c = cfg();
  const hdrs = [
    `From: ${c.fromName} <${c.user}>`,
    `To: ${toName ? `${toName} <${toEmail}>` : toEmail}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
  ];
  const raw = b64urlEncode(hdrs.join("\r\n") + "\r\n\r\n" + body);
  const sent = await gapi("/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
  let messageIdHeader = "";
  try {
    const meta = await gapi(`/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`);
    messageIdHeader = getHeader(meta.payload && meta.payload.headers, "Message-ID");
  } catch (_) {}
  return { id: sent.id, threadId: sent.threadId, messageIdHeader };
}

// Send a follow-up as a threaded reply inside an existing outreach thread.
async function sendThreadReply({ toEmail, toName, subject, body, threadId, inReplyTo, references }) {
  const c = cfg();
  const subj = /^re:/i.test(String(subject || "").trim()) ? subject : `Re: ${subject}`;
  const hdrs = [
    `From: ${c.fromName} <${c.user}>`,
    `To: ${toName ? `${toName} <${toEmail}>` : toEmail}`,
    `Subject: ${subj}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
    references ? `References: ${references}` : inReplyTo ? `References: ${inReplyTo}` : "",
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
  ].filter(Boolean);
  const raw = b64urlEncode(hdrs.join("\r\n") + "\r\n\r\n" + body);
  const sent = await gapi("/messages/send", { method: "POST", body: JSON.stringify({ raw, threadId }) });
  return { id: sent.id, threadId: sent.threadId };
}

// Has anyone other than us posted in this thread? Used to stop follow-ups once a lead replies.
async function threadHasExternalReply(threadId) {
  if (!threadId) return false;
  const c = cfg();
  const ourEmail = (c.user || "").toLowerCase();
  try {
    const thread = await gapi(`/threads/${threadId}?format=metadata&metadataHeaders=From`);
    for (const m of thread.messages || []) {
      const fromEmail = parseEmail(getHeader(m.payload && m.payload.headers, "From"));
      if (fromEmail && fromEmail !== ourEmail) return true;
    }
  } catch (_) {}
  return false;
}

module.exports = { isConfigured, consentUrl, exchangeCode, pollAndReply, inspectInbox, reprocessInbox, startGmailPoller, cfg, sendNewEmail, sendThreadReply, threadHasExternalReply };
