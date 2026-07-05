const GHL_API_BASE = "https://services.leadconnectorhq.com";

// Cache channel type per contact so we only look it up once
const channelCache = new Map();
const DEFAULT_TYPE = process.env.GHL_DEFAULT_CHANNEL || "FB";

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    "Content-Type": "application/json",
    Version: "2021-04-15",
  };
}

async function sendReply(contactId, message, locationId) {
  // Use cached type or default (FB for this account)
  const type = channelCache.get(contactId) || DEFAULT_TYPE;
  console.log(`Sending reply as type: ${type} to contact ${contactId}`);

  const response = await fetch(`${GHL_API_BASE}/conversations/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type,
      contactId,
      message,
    }),
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
  const bubbles = splitIntoBubbles(message);
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

module.exports = { sendReply, sendReplyHuman, sendTypingIndicator, setChannelType, splitIntoBubbles };
