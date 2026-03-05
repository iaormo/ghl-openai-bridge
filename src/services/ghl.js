const GHL_API_BASE = "https://services.leadconnectorhq.com";

async function sendReply(contactId, message, locationId) {
  const response = await fetch(`${GHL_API_BASE}/conversations/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-04-15",
    },
    body: JSON.stringify({
      type: "SMS",
      contactId,
      message,
      ...(locationId && { locationId }),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GHL API error (${response.status}): ${error}`);
  }

  return response.json();
}

module.exports = { sendReply };
