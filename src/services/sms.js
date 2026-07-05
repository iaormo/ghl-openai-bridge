// Android SMS Gateway (sms-gate.app) integration — connect a Philippine phone number via webhook.
// Inbound: the app POSTs received SMS to /webhook/sms. Outbound: we POST to the cloud send API,
// and the app sends the SMS from the phone's SIM. All endpoints/creds are env-configurable.

const GATEWAY_URL = process.env.SMS_GATEWAY_URL || "https://api.sms-gate.app/3rdparty/v1/messages";
const GATEWAY_USER = process.env.SMS_GATEWAY_USER || "";
const GATEWAY_PASS = process.env.SMS_GATEWAY_PASS || "";

// Send an SMS reply via the Android gateway's cloud API.
async function sendSms(phone, message) {
  if (!GATEWAY_USER || !GATEWAY_PASS) {
    console.warn("SMS gateway creds (SMS_GATEWAY_USER / SMS_GATEWAY_PASS) not set — cannot send SMS");
    return;
  }
  const auth = Buffer.from(`${GATEWAY_USER}:${GATEWAY_PASS}`).toString("base64");
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ textMessage: { text: message }, phoneNumbers: [phone] }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`SMS send failed (${res.status}): ${txt}`);
  console.log(`SMS gateway send ok: ${txt.slice(0, 120)}`);
  return txt;
}

// Parse an inbound SMS from the gateway's webhook payload (defensive across shapes/versions).
function parseInboundSms(body) {
  const p = (body && body.payload) || body || {};
  const from = p.phoneNumber || p.phone || p.from || p.sender || body.from || body.phoneNumber || null;
  const text = p.message || p.text || p.body || body.message || body.text || null;
  const messageId = p.messageId || p.id || body.id || null;
  return { from, text, messageId };
}

module.exports = { sendSms, parseInboundSms };
