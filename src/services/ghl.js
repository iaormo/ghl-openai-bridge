const GHL_API_BASE = "https://services.leadconnectorhq.com";

// Cache channel type per contact so we only look it up once
const channelCache = new Map();
// Cache email thread metadata (subject / thread id) so email replies thread correctly
const emailMeta = new Map();
const DEFAULT_TYPE = process.env.GHL_DEFAULT_CHANNEL || "FB";

function setEmailMeta(contactId, meta) {
  if (!contactId || !meta) return;
  const cur = emailMeta.get(contactId) || {};
  const next = { ...cur };
  for (const k of ["subject", "threadId", "messageId", "emailFrom", "emailTo"]) {
    if (meta[k]) next[k] = meta[k];
  }
  emailMeta.set(contactId, next);
}

function getChannelType(contactId) {
  return channelCache.get(contactId) || DEFAULT_TYPE;
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    "Content-Type": "application/json",
    Version: "2021-04-15",
  };
}

// Strip markdown so messages render as plain text on FB/IG/SMS/WhatsApp (which show **, #,
// backticks, and [](links) as literal characters).
function stripMarkdown(text) {
  if (!text) return text;
  let t = String(text);
  t = t.replace(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g, "$1"); // images -> url
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1: $2"); // [text](url) -> text: url
  t = t.replace(/```[a-z]*\n?/gi, "").replace(/```/g, ""); // code fences
  t = t.replace(/`([^`]+)`/g, "$1"); // inline code
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // headings
  t = t.replace(/^\s{0,3}>\s?/gm, ""); // blockquotes
  t = t.replace(/^\s*[-*+]\s+/gm, "• "); // list bullets -> •
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1"); // **bold**
  t = t.replace(/__([^_]+)__/g, "$1"); // __bold__
  t = t.replace(/\*([^*\n]+)\*/g, "$1"); // *italic*
  t = t.replace(/(^|[\s(])_([^_\n]+)_([\s).,!?]|$)/g, "$1$2$3"); // _italic_
  t = t.replace(/\*\*/g, "").replace(/(^|\s)#{1,6}(\s|$)/g, "$1$2"); // stray markers
  return t.replace(/[ \t]+\n/g, "\n").trim();
}

async function sendReply(contactId, message, locationId) {
  // Use cached type or default (FB for this account)
  const type = channelCache.get(contactId) || DEFAULT_TYPE;
  console.log(`Sending reply as type: ${type} to contact ${contactId}`);

  const clean = stripMarkdown(message);
  const payload = { type, contactId, message: clean };

  // Email needs a subject (and threads better with subject/thread id + html body)
  if (type === "Email") {
    const meta = emailMeta.get(contactId) || {};
    let subject = meta.subject || "Your message to ScalePlus";
    if (!/^re:/i.test(subject.trim())) subject = `Re: ${subject}`;
    payload.subject = subject;
    payload.html = clean.replace(/\n/g, "<br>");
    if (meta.threadId) payload.threadId = meta.threadId;
    if (meta.emailFrom) payload.emailTo = meta.emailFrom; // reply back to the sender
  }

  const response = await fetch(`${GHL_API_BASE}/conversations/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GHL API error (${response.status}): ${error}`);
  }

  return response.json();
}

// ---- Human-feel delivery: split long replies into chat bubbles sent in bursts ----

// Split on sentence boundaries into chat-sized bubbles (max 3). Short replies stay whole.
function splitIntoBubbles(text, maxLen = 220, maxBubbles = 3) {
  if (!text || text.length <= maxLen * 1.2) return [text];
  const parts = text.split(/(?<=[.!?…])\s+|\n{2,}/).filter((p) => p && p.trim());
  const bubbles = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + " " + p).length > maxLen) {
      bubbles.push(cur.trim());
      cur = p;
    } else {
      cur = cur ? cur + " " + p : p;
    }
  }
  if (cur.trim()) bubbles.push(cur.trim());
  if (bubbles.length > maxBubbles) {
    const head = bubbles.slice(0, maxBubbles - 1);
    head.push(bubbles.slice(maxBubbles - 1).join(" "));
    return head;
  }
  return bubbles;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Channels where multi-bubble delivery reads naturally. NOT SMS (costs per segment)
// and NOT Email (should be a single message).
const SPLIT_CHANNELS = new Set(["FB", "IG", "Live_Chat", "WhatsApp"]);

// Send a reply the way a human would: first bubble immediately, following bubbles after a
// short typing-length-proportional pause. Falls back to a single send on non-chat channels.
async function sendReplyHuman(contactId, message, locationId) {
  const type = channelCache.get(contactId) || DEFAULT_TYPE;
  if (!SPLIT_CHANNELS.has(type)) {
    return sendReply(contactId, message, locationId);
  }
  const bubbles = splitIntoBubbles(stripMarkdown(message));
  let last;
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      // "typing" pause proportional to the upcoming bubble's length
      await sleep(Math.min(600 + bubbles[i].length * 25, 2500));
    }
    last = await sendReply(contactId, bubbles[i], locationId);
  }
  return last;
}

// ---- Quick acknowledgment ("one sec") to mimic a human seeing the message + typing ----

const ACK_LINES = [
  "ooh good question — one sec 👀",
  "one sec, lemme check for you 😊",
  "on it — gimme a moment 🙌",
  "great q, let me pull that up 🤔",
  "sec, checking that for you 👇",
  "ohh let me sort that real quick",
  "gotcha — one moment 😊",
  "let me grab that for you, sec",
];

// Send a short human-style ack immediately, chat channels only. Best-effort, never throws.
// Not saved to conversation history — it's pure UX, invisible to the AI.
async function sendQuickAck(contactId, locationId) {
  const type = channelCache.get(contactId) || DEFAULT_TYPE;
  if (!SPLIT_CHANNELS.has(type)) return; // FB/IG/WhatsApp/Live Chat only — never SMS/Email
  const line = ACK_LINES[Math.floor(Math.random() * ACK_LINES.length)];
  try {
    await sendReply(contactId, line, locationId);
  } catch (err) {
    console.warn("Quick ack failed (non-fatal):", err.message);
  }
}

// Decide if a message is "substantial" enough to warrant an ack (skip greetings / one-word
// replies so it never feels spammy).
function shouldAck(message) {
  if (!message) return false;
  const m = message.trim();
  // Ack EVERYTHING except clear greetings / acknowledgments / confirmations. This includes
  // short/informal messages like "hm", "?", "how much", "info", "magkano" — they deserve a
  // beat too, and the bot may need a moment to interpret or clarify them.
  const trivial = /^(hi+|hey+|hello+|yo|ok|okay|k+|kk|yes|yep|yup|yeah|no|nope|sure|thanks|thank you|ty|thx|salamat|great|cool|nice|got it|sounds good|perfect|alright|okay lang|sige)[\s.!]*$/i;
  if (trivial.test(m)) return false;
  return true;
}

// ---- Live Chat typing indicator (GHL only supports this for the Live Chat channel) ----

// Best-effort: show the "agent is typing" animation while the AI composes. Fire-and-forget;
// never throws into the main flow.
async function sendTypingIndicator(contactId, locationId) {
  const type = channelCache.get(contactId) || DEFAULT_TYPE;
  if (type !== "Live_Chat") return; // API only supports live chat
  try {
    const search = await fetch(
      `${GHL_API_BASE}/conversations/search?contactId=${contactId}&locationId=${locationId || process.env.GHL_LOCATION_ID}`,
      { headers: headers() }
    );
    if (!search.ok) return;
    const data = await search.json();
    const conversationId = data.conversations && data.conversations[0] && data.conversations[0].id;
    if (!conversationId) return;
    const res = await fetch(`${GHL_API_BASE}/conversations/providers/live-chat/typing`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        locationId: locationId || process.env.GHL_LOCATION_ID,
        conversationId,
        isTyping: true,
      }),
    });
    console.log(`Live chat typing indicator: HTTP ${res.status}`);
  } catch (err) {
    console.warn("Typing indicator failed (non-fatal):", err.message);
  }
}

// Allow setting channel type from webhook payload
function setChannelType(contactId, ghlMessageType) {
  const typeMap = {
    11: "FB",           // TYPE_FACEBOOK
    2: "SMS",           // TYPE_SMS
    3: "Email",         // TYPE_EMAIL
    15: "IG",           // TYPE_INSTAGRAM
    18: "WhatsApp",     // TYPE_WHATSAPP
    6: "Live_Chat",     // TYPE_LIVE_CHAT
  };
  if (ghlMessageType && typeMap[ghlMessageType]) {
    channelCache.set(contactId, typeMap[ghlMessageType]);
  }
}

module.exports = { sendReply, sendReplyHuman, sendTypingIndicator, sendQuickAck, shouldAck, setChannelType, setEmailMeta, getChannelType, splitIntoBubbles, stripMarkdown };
