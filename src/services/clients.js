// Skye's inbound-email policy + per-client context, driven by clients.md at the repo root.
//
// clients.md has three list sections — "Clients" (always reply), "Never auto-reply" (skip),
// and "Skip subjects" (skip unless the sender is a client). A Client line may carry a free-text
// note and, optionally, a "[knowledge: file.md, other.md]" tag pointing at extra knowledge files
// that get loaded ONLY when that client emails (e.g. redline.md for Redline contacts) — so
// confidential/large context never leaks into general replies or bloats them.
//
// Mirrors brain.js: edit the .md, redeploy, done.

const fs = require("fs");
const path = require("path");
const { getKnowledgeFile } = require("./brain");

const CLIENTS_PATH = path.join(__dirname, "..", "..", "clients.md");

let cache = null;

const EMAIL_OR_DOMAIN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|[a-z0-9.-]+\.[a-z]{2,}/i;
const KNOWLEDGE_TAG = /\[knowledge:\s*([^\]]+)\]/i;

function parse(md) {
  const clients = new Map(); // key(email|domain) → { note, files: [] }
  const blocked = new Set();
  const skipSubjects = [];
  let section = null;

  for (const raw of String(md).split("\n")) {
    const line = raw.trim();
    // Section headings switch which list we're filling.
    if (/^#{1,6}\s/.test(line)) {
      const h = line.replace(/^#{1,6}\s+/, "").toLowerCase();
      if (/never|do.?not|block|exclude|ignore/.test(h)) section = "blocked";
      else if (/skip.*subject|^subject/.test(h)) section = "subjects";
      else if (/client|always.*reply|whitelist/.test(h)) section = "clients";
      else section = null;
      continue;
    }
    // Only dash/asterisk list items are entries.
    if (!/^[-*]\s+/.test(line)) continue;
    const val = line.replace(/^[-*]\s+/, "").trim();
    if (!val) continue;

    if (section === "subjects") {
      skipSubjects.push(val.toLowerCase());
      continue;
    }
    if (section !== "clients" && section !== "blocked") continue;

    const m = val.match(EMAIL_OR_DOMAIN);
    if (!m) continue;
    const key = m[0].toLowerCase();

    if (section === "blocked") {
      blocked.add(key);
      continue;
    }

    // Clients: capture the note (rest of the line) + any [knowledge: ...] files.
    let note = val.slice(val.indexOf(m[0]) + m[0].length).replace(/^[\s—–:-]+/, "").trim();
    const files = [];
    const kn = note.match(KNOWLEDGE_TAG);
    if (kn) {
      kn[1].split(",").map((s) => s.trim()).filter(Boolean).forEach((f) => files.push(f));
      note = note.replace(kn[0], "").replace(/\s{2,}/g, " ").trim();
    }
    clients.set(key, { note, files });
  }
  return { clients, blocked, skipSubjects };
}

function getPolicy() {
  if (cache) return cache;
  try {
    cache = parse(fs.readFileSync(CLIENTS_PATH, "utf8"));
    console.log(
      `Loaded clients.md — ${cache.clients.size} client(s), ${cache.blocked.size} blocked, ${cache.skipSubjects.length} skip-subject rule(s)`
    );
  } catch (err) {
    console.warn("Could not read clients.md:", err.message);
    cache = { clients: new Map(), blocked: new Set(), skipSubjects: [] };
  }
  return cache;
}

function reload() {
  cache = null;
  return getPolicy();
}

const domainOf = (email) => String(email).toLowerCase().split("@")[1] || "";

// The client record for an address (matched by exact email OR its domain), or null.
function clientEntry(email) {
  const { clients } = getPolicy();
  const e = String(email).toLowerCase();
  return clients.get(e) || clients.get(domainOf(e)) || null;
}

function isClient(email) {
  return !!clientEntry(email);
}

// True if the address OR its domain is on a Set (used for the blocked list).
function onList(set, email) {
  const e = String(email).toLowerCase();
  return set.has(e) || (domainOf(e) && set.has(domainOf(e)));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Decide whether Skye should auto-reply to one email.
//   automated = caller's header-based "not a human" verdict (no-reply, mailing list, etc.)
// Returns { reply: boolean, reason: string }.
function classify({ fromEmail, subject = "", automated = false }) {
  const p = getPolicy();
  if (isClient(fromEmail)) return { reply: true, reason: "client (always reply)" };
  if (automated) return { reply: false, reason: "automated / not a human" };
  if (onList(p.blocked, fromEmail)) return { reply: false, reason: "blocked sender" };
  const s = String(subject).toLowerCase();
  const hit = p.skipSubjects.find((w) => new RegExp(`\\b${escapeRe(w)}\\b`, "i").test(s));
  if (hit) return { reply: false, reason: `skip-subject "${hit}"` };
  return { reply: true, reason: "human inbound" };
}

// Extra system-prompt context for a known client: an "existing client" nudge, their note,
// and the contents of any [knowledge:] files they're mapped to. Returns "" for non-clients.
function clientContext(email) {
  const entry = clientEntry(email);
  if (!entry) return "";
  let ctx =
    "\n\n[CLIENT CONTEXT: This sender is an EXISTING ScalePlus client/contact. Reply as their friendly account contact — warm, helpful, focused on resolving their request. Do NOT pitch the free automation audit or treat them like a new lead. Any KNOWLEDGE FILE below is confidential to this relationship — use it to answer well, but never expose it wholesale or share it with anyone else.]";
  if (entry.note) ctx += `\nWho they are: ${entry.note}`;
  const seen = new Set();
  for (const f of entry.files || []) {
    if (seen.has(f)) continue;
    seen.add(f);
    const content = getKnowledgeFile(f);
    if (content) ctx += `\n\n===== KNOWLEDGE FILE: ${f} =====\n${content}`;
  }
  return ctx;
}

module.exports = { getPolicy, reload, isClient, classify, clientEntry, clientContext, parse, CLIENTS_PATH };
