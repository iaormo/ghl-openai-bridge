const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "";

// Find the most recent conversation for a contact to detect the channel type
async function getConversationType(contactId) {
  try {
    const response = await fetch(
      `${GHL_API_BASE}/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          Version: "2021-04-15",
        },
      }
    );
    if (!response.ok) return "TYPE_FACEBOOK"; // default for this account
    const data = await response.json();
    const convo = data.conversations?.[0];
    return convo?.lastMessageType || "TYPE_FACEBOOK";
  } catch {
    return "TYPE_FACEBOOK";
  }
}

async function sendReply(contactId, message, locationId) {
  // Auto-detect the channel type from the conversation
  const messageType = await getConversationType(contactId);

  // Map GHL conversation types to message send types
  const typeMap = {
    TYPE_FACEBOOK: "FB",
    TYPE_INSTAGRAM: "IG",
    TYPE_SMS: "SMS",
    TYPE_EMAIL: "Email",
    TYPE_LIVE_CHAT: "Live_Chat",
    TYPE_WHATSAPP: "WhatsApp",
  };

  const type = typeMap[messageType] || "FB";
  console.log(`Sending reply as type: ${type} (detected: ${messageType})`);

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

module.exports = { sendReply };
