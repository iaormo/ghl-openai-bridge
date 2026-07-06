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
const { chat } = require("./openai");
const { upsertContactByEmail } = require("./contacts");

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

const AUTOMATED = /(noreply|no-reply|mailer-daemon|postmaster|notifications?@|donotreply|do-not-reply|bounce)/i;

// Check the scoped label for unread emails and reply to each real one. Marks handled emails read.
async function pollAndReply() {
  if (!isConfigured()) return;
  const c = cfg();
  let labelId;
  try { labelId = await getLabelId(c.label); } catch (e) { console.warn("Gmail label lookup failed:", e.message); return; }
  if (!labelId) { console.warn(`Gmail label "${c.label}" not found — create it and a filter that applies it to inquiries`); return; }

  let list;
  try { list = await gapi(`/messages?labelIds=${labelId}&labelIds=UNREAD&maxResults=10`); }
  catch (e) { console.warn("Gmail list failed:", e.message); return; }
  const ids = (list.messages || []).map((m) => m.id);
  if (!ids.length) return;

  for (const id of ids) {
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

      // Skip our own mail and automated senders; mark read so we don't reprocess
      if (fromEmail === c.user.toLowerCase() || AUTOMATED.test(from) || !body) {
        await gapi(`/messages/${id}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) });
        continue;
      }

      // Contact in GHL so booking/notes/memory work, then generate the reply as Email
      let contactId = null;
      try { contactId = await upsertContactByEmail(fromEmail, from); } catch (e) { console.warn("Gmail contact upsert failed:", e.message); }
      const reply = await chat(contactId || `gmail:${fromEmail}`, body, "Email");

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
      await gapi(`/messages/${id}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) });
      console.log(`Gmail: replied to ${fromEmail} re "${subject}"`);
    } catch (e) {
      console.error(`Gmail: failed to handle message ${id}:`, e.message);
    }
  }
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

module.exports = { isConfigured, consentUrl, exchangeCode, pollAndReply, startGmailPoller, cfg };
