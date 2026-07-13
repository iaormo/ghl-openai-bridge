// 8x8 CPaaS SMS — outbound texting from ScalePlus. Used to send Skye's organic first-touch SMS to
// leads who submit a form / are created with a phone number. Graceful no-op if not configured.
// Env: SMS8X8_API_KEY, SMS8X8_SUBACCOUNT, SMS8X8_SOURCE (sender id / number).

const SMS8X8_API_KEY = process.env.SMS8X8_API_KEY || "";
const SMS8X8_SUBACCOUNT = process.env.SMS8X8_SUBACCOUNT || "";
const SMS8X8_SOURCE = process.env.SMS8X8_SOURCE || "ScalePlus";

if (!SMS8X8_API_KEY || !SMS8X8_SUBACCOUNT) {
  console.warn("⚠ SMS8X8_API_KEY / SMS8X8_SUBACCOUNT not set — 8x8 SMS outreach is disabled.");
}

// Best-effort E.164. Form is PH-centric ("+63 9XX…"); bare 09/0 → Philippine; a leading + is trusted.
function toE164(p) {
  const s = String(p || "").replace(/[^\d+]/g, "");
  if (!s) return "";
  if (s[0] === "+") return s;
  if (s.slice(0, 2) === "09" || s[0] === "0") return "+63" + s.replace(/^0+/, "");
  if (s.slice(0, 2) === "63") return "+" + s;
  return "+" + s;
}

// Send an SMS via 8x8. Returns { ok, skipped? }. Never throws.
async function sendSms8x8(phone, text) {
  try {
    const dest = toE164(phone);
    if (!SMS8X8_API_KEY || !SMS8X8_SUBACCOUNT || !dest || !text) return { ok: false, skipped: true };
    const res = await fetch(
      `https://sms.8x8.com/api/v1/subaccounts/${encodeURIComponent(SMS8X8_SUBACCOUNT)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SMS8X8_API_KEY}` },
        body: JSON.stringify({ source: SMS8X8_SOURCE, destination: dest, text, encoding: "AUTO" }),
      }
    );
    const body = await res.text();
    if (!res.ok) { console.error("8x8 SMS failed:", res.status, body.slice(0, 200)); return { ok: false }; }
    console.log("8x8 SMS sent:", body.slice(0, 160));
    return { ok: true };
  } catch (e) {
    console.error("8x8 SMS exception:", e.message);
    return { ok: false };
  }
}

module.exports = { sendSms8x8, toE164 };
