const GHL_API_BASE = "https://services.leadconnectorhq.com";

// Cache channel type per contact so we only look it up once
const channelCache = new Map();
const DEFAULT_TYPE = process.env.GHL_DEFAULT_CHANNEL || "FB";

async function sendReply(contactId, message, locationId) {
  // Use cached type or default (FB for this account)
  const type = channelCache.get(contactId) || DEFAULT_TYPE;
  console.log(`Sending reply as type: ${type} to contact ${contactId}`);

  const response = await fetch(`${GHL_API_BASE}/conversations/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-04-15",
    },
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

module.exports = { sendReply, setChannelType };
