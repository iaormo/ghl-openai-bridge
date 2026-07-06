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
  if (typeof meta.isReply === "boolean") next.isReply = meta.isReply;
  emailMeta.set(contactId, next);
}

function getChannelType(contactId) {
  return channelCache.get(contactId) || DEFAULT_TYPE;
}

// For an inbound email, look up the contact's email conversation in GHL to grab the subject +
// thread/conversation id + last message id, so the reply threads in-place with "Re: <subject>".
// (GHL's workflow webhook doesn't include these.) Best-effort; safe to fail.
async function captureEmailThread(contactId, locationId) {
  try {
    const loc = locationId || process.env.GHL_LOCATION_ID;
    const s = await fetch(
      `${GHL_API_BASE}/conversations/search?locationId=${loc}&contactId=${contactId}`,
      { headers: headers() }
    );
    let subject = null;
    if (s.ok) {
      const sd = await s.json();
      const conv = (sd.conversations || [])[0];
      if (conv) {
        const m = await fetch(`${GHL_API_BASE}/conversations/${conv.id}/messages`, { headers: headers() });
        if (m.ok) {
          const md = await m.json();
          const msgs = (md.messages && md.messages.messages) || md.messages || [];
          // GHL stores the email subject at message.meta.email.subject. Grab the latest
          // INBOUND (non-outbound) email's subject so we reply "Re: <their subject>".
          const lastInbound = msgs.find(
            (x) => x && x.type === 3 && x.direction !== "outbound" && x.meta && x.meta.email && x.meta.email.subject
          );
          if (lastInbound) subject = lastInbound.meta.email.subject;
        }
      }
    }
    // Mark as a reply so the send adds "Re:". GHL threads it by contactId; no threadId needed.
    setEmailMeta(contactId, subject ? { isReply: true, subject } : { isReply: true });
    console.log(`Email thread captured for ${contactId}: subject="${subject || "(none)"}" reply=true`);
  } catch (e) {
    console.warn("captureEmailThread failed:", e.message);
  }
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
    let bodyText = clean;
    let subject = meta.subject || "Your message to ScalePlus";
    // If the model wrote a leading "Subject: ..." line, use it as the real subject and strip it
    const sm = bodyText.match(/^\s*subject:\s*(.+?)\s*\r?\n+/i);
    if (sm) {
      subject = sm[1].trim();
      bodyText = bodyText.slice(sm[0].length).trim();
    }
    if (meta.isReply && !/^re:/i.test(subject.trim())) subject = `Re: ${subject}`;
    payload.subject = subject;
    payload.message = bodyText;
    payload.html = bodyText.replace(/\n/g, "<br>");
    if (meta.emailFrom) payload.emailTo = meta.emailFrom; // reply back to the sender
    // NOTE: GHL threads the reply into the contact's existing email conversation automatically
    // by contactId. Do NOT pass threadId/replyMessageId — GHL 400s if they aren't a valid
    // email-thread id (the conversation id is not one), which silently kills the send.
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

const VALID_CHANNELS = new Set(["FB", "IG", "SMS", "Email", "WhatsApp", "Live_Chat", "GMB"]);

// Set the reply channel for a contact directly (validated string).
function setChannel(contactId, channel) {
  if (contactId && VALID_CHANNELS.has(channel)) channelCache.set(contactId, channel);
}

// Allow setting channel type from a numeric GHL message type
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

// Best-effort channel detection from a GHL webhook payload. An explicit `channel` field
// (set as custom data in the GHL workflow's webhook action) is the most reliable signal.
function channelFromText(s) {
  const t = String(s || "").toLowerCase();
  if (!t) return null;
  if (/\bemail\b|e-?mail/.test(t)) return "Email";
  if (/whats\s?app/.test(t)) return "WhatsApp";
  if (/instagram|\big\b/.test(t)) return "IG";
  if (/\bsms\b|\btext\b/.test(t)) return "SMS";
  if (/live\s?chat|web\s?chat/.test(t)) return "Live_Chat";
  if (/\bgmb\b|google/.test(t)) return "GMB";
  if (/facebook|messenger|\bfb\b/.test(t)) return "FB";
  return null;
}

function detectChannel(body) {
  if (!body) return null;
  const strMap = {
    email: "Email", fb: "FB", facebook: "FB", messenger: "FB", ig: "IG", instagram: "IG",
    sms: "SMS", text: "SMS", whatsapp: "WhatsApp", wa: "WhatsApp",
    live_chat: "Live_Chat", livechat: "Live_Chat", webchat: "Live_Chat", chat: "Live_Chat", gmb: "GMB",
  };
  // 1) explicit `channel` custom data — GHL nests custom webhook data under customData
  const explicit = String(
    body.customData?.channel || body.customData?.Channel || body.channel || body.Channel || body.reply_channel || ""
  ).toLowerCase().trim();
  if (strMap[explicit]) return strMap[explicit];
  // 2) numeric message type (raw inbound webhook format)
  const numMap = { 11: "FB", 2: "SMS", 3: "Email", 15: "IG", 18: "WhatsApp", 6: "Live_Chat" };
  const numT = body.message?.type ?? body.messageType ?? body.message_type;
  if (numT != null && numMap[numT]) return numMap[numT];
  // 3) the workflow NAME (workflows are named by channel, e.g. "010.A Email Bot Trigger")
  const fromWf = channelFromText(body.workflow?.name);
  if (fromWf) return fromWf;
  // 4) any string message-type field
  return channelFromText(body.message?.type || body.lastMessageType || body.last_message_type || body.type);
}

module.exports = { sendReply, sendReplyHuman, sendTypingIndicator, sendQuickAck, shouldAck, setChannelType, setChannel, detectChannel, setEmailMeta, captureEmailThread, getChannelType, splitIntoBubbles, stripMarkdown };
