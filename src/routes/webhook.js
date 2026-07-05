const express = require("express");
const { chat, composeOutreach } = require("../services/openai");
const { sendReply, sendReplyHuman, sendTypingIndicator, setChannelType, setChannel, detectChannel, setEmailMeta, getChannelType } = require("../services/ghl");

const router = express.Router();

// Track recently processed messages to prevent duplicates
const processed = new Map();
const DEDUP_TTL = 60_000; // 60 seconds

// Track recent form outreach so a form submission never triggers two emails
const outreachSent = new Map();
const OUTREACH_DEDUP_TTL = 10 * 60_000; // 10 minutes

// Build a readable summary of form fields present in the webhook payload
function summarizeFormPayload(body) {
  const parts = [];
  if (body.message?.body) parts.push(String(body.message.body).trim());
  const cd = body.customData || body.custom_data;
  if (cd && typeof cd === "object") {
    for (const [k, v] of Object.entries(cd)) {
      if (v && String(v).trim()) parts.push(`${k}: ${v}`);
    }
  }
  // common form field names GHL may pass at the top level
  const fields = ["service", "interest", "budget", "company", "business", "website", "industry",
    "how_can_we_help", "message_body", "comments", "details", "notes", "need", "goal", "inquiry"];
  for (const f of fields) {
    if (body[f] && String(body[f]).trim()) parts.push(`${f}: ${body[f]}`);
  }
  return parts.join("\n");
}

function isDuplicate(messageId) {
  if (!messageId) return false;
  if (processed.has(messageId)) return true;
  processed.set(messageId, Date.now());
  // Clean old entries
  for (const [key, ts] of processed) {
    if (Date.now() - ts > DEDUP_TTL) processed.delete(key);
  }
  return false;
}

router.post("/inbound", async (req, res) => {
  try {
    const body = req.body;

    // --- LOOP PREVENTION ---
    // 1. Ignore outbound messages (sent BY the bot/system, not by the contact)
    const direction = body.direction || body.messageDirection || body.type;
    if (direction === "outbound" || direction === "outgoing") {
      console.log("Skipping outbound message (loop prevention)");
      return res.json({ skipped: true, reason: "outbound message" });
    }

    // 2. Deduplicate by messageId so the same message isn't processed twice
    const messageId = body.messageId || body.message_id || body.id;
    if (isDuplicate(messageId)) {
      console.log(`Skipping duplicate message ${messageId}`);
      return res.json({ skipped: true, reason: "duplicate" });
    }

    // --- EXTRACT PAYLOAD (matched to actual GHL webhook structure) ---
    const contactId = body.contact_id || body.contactId || body.contact?.id;
    const message =
      body.message?.body ||       // GHL sends { message: { type: 11, body: "HEY" } }
      (typeof body.message === "string" ? body.message : null) ||
      body.body ||
      body.messageBody;
    const locationId = body.location?.id || body.locationId || body.location_id;

    if (!contactId || !message) {
      // Respond 200 (not 400) so GHL's "Test" button and non-message events don't show as
      // failed and GHL doesn't auto-disable the webhook. Real messages still process below.
      console.warn(
        `Inbound webhook ignored — no contactId/message (likely a GHL test or non-message event). contactId=${contactId} hasMessage=${!!message}`
      );
      return res.status(200).json({
        skipped: true,
        reason: "no contactId or message in payload (ignored)",
        received: { contactId, message },
        hint: "For real messages, ensure the payload includes contact_id and message.body",
      });
    }

    // Detect the reply channel: explicit customData.channel wins, else the workflow name
    // (workflows are named per channel), else numeric message type. Falls back to default.
    const detected = detectChannel(body);
    if (detected) {
      setChannel(contactId, detected);
    } else if (body.message?.type) {
      setChannelType(contactId, body.message.type);
    }

    // For email, capture subject + thread info so the reply threads and has a subject line
    const channel = getChannelType(contactId);
    console.log(
      `Channel: ${detected || "(none→" + channel + ")"} | workflow: ${body.workflow?.name || "-"} | contact ${contactId}`
    );
    if (channel === "Email") {
      setEmailMeta(contactId, {
        subject: body.subject || body.message?.subject || body.email?.subject,
        threadId: body.threadId || body.thread_id || body.conversationId || body.conversation_id,
        messageId: body.messageId || body.message_id || body.message?.id,
        emailFrom: body.emailFrom || body.email?.from || body.from,
      });
    }

    console.log(`Incoming ${channel} message from contact ${contactId}: ${message}`);

    // Respond immediately so GHL doesn't timeout or retry
    res.json({ success: true, contactId, status: "processing" });

    // --- PROCESS ASYNC (after response sent) ---
    // Live Chat native typing animation while the AI composes (no-op on other channels)
    sendTypingIndicator(contactId, locationId);

    const reply = await chat(contactId, message, channel);
    console.log(`AI reply for contact ${contactId}: ${reply}`);

    if (process.env.GHL_API_KEY) {
      await sendReplyHuman(contactId, reply, locationId);
      console.log(`Reply sent back to GHL for contact ${contactId}`);
    }
  } catch (error) {
    console.error("Webhook error:", error);
    // Only send error response if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({
        error: "Failed to process webhook",
        message: error.message,
      });
    }
  }
});

// --- FORM OUTREACH: a lead filled out the scaleplus.io form -> send them a first-touch email ---
router.post("/form", async (req, res) => {
  try {
    const body = req.body;
    const contactId = body.contact_id || body.contactId || body.contact?.id;
    if (!contactId) {
      return res.status(200).json({ skipped: true, reason: "no contactId in payload" });
    }

    // Don't email the same lead twice for one submission (retries / duplicate triggers)
    const now = Date.now();
    const last = outreachSent.get(contactId);
    for (const [k, ts] of outreachSent) if (now - ts > OUTREACH_DEDUP_TTL) outreachSent.delete(k);
    if (last && now - last < OUTREACH_DEDUP_TTL) {
      return res.status(200).json({ skipped: true, reason: "outreach already sent recently" });
    }
    outreachSent.set(contactId, now);

    const locationId = body.location?.id || body.locationId || body.location_id;
    console.log(`Form outreach trigger for contact ${contactId} | workflow: ${body.workflow?.name || "-"}`);

    // Respond immediately so GHL doesn't retry
    res.json({ success: true, contactId, status: "sending outreach" });

    // Build context from the form payload, then compose + send the email
    const formContext = summarizeFormPayload(body);
    setChannel(contactId, "Email");
    setEmailMeta(contactId, { subject: "Thanks for reaching out to ScalePlus 👋" });

    const email = await composeOutreach(contactId, formContext);
    if (email && process.env.GHL_API_KEY) {
      await sendReplyHuman(contactId, email, locationId);
      console.log(`Outreach email sent to contact ${contactId}`);
    } else {
      console.warn(`Outreach not sent for ${contactId} (no email text or no GHL key)`);
    }
  } catch (error) {
    console.error("Form outreach error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Debug endpoint — runs the full flow synchronously and returns errors
router.post("/debug", async (req, res) => {
  const steps = {};
  try {
    // 1. Check env vars
    steps.env = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "set (" + process.env.OPENAI_API_KEY.slice(0, 8) + "...)" : "MISSING",
      OPENAI_ASSISTANT_ID: process.env.OPENAI_ASSISTANT_ID || "MISSING",
      GHL_API_KEY: process.env.GHL_API_KEY ? "set (" + process.env.GHL_API_KEY.slice(0, 8) + "...)" : "MISSING",
      DATABASE_URL: process.env.DATABASE_URL ? "set" : "MISSING",
    };

    // 2. Extract payload
    const body = req.body;
    const contactId = body.contactId || body.contact_id || "debug-test";
    const message = body.message || "Hello, this is a debug test";
    steps.payload = { contactId, message };

    // 3. Try OpenAI
    steps.openai = "calling...";
    const reply = await chat(contactId, message);
    steps.openai = { success: true, reply };

    // 4. Try GHL reply
    if (process.env.GHL_API_KEY && body.contactId) {
      steps.ghl = "calling...";
      const locationId = body.locationId || body.location_id;
      await sendReply(contactId, reply, locationId);
      steps.ghl = { success: true };
    } else {
      steps.ghl = "skipped (no GHL_API_KEY or no real contactId)";
    }

    res.json({ success: true, steps });
  } catch (error) {
    steps.error = { message: error.message, stack: error.stack?.split("\n").slice(0, 3) };
    res.status(500).json({ success: false, steps });
  }
});

// Capture endpoint — logs exactly what GHL sends so we can see field names
let lastPayload = null;
router.post("/capture", (req, res) => {
  lastPayload = { receivedAt: new Date().toISOString(), body: req.body };
  console.log("CAPTURED PAYLOAD:", JSON.stringify(req.body, null, 2));
  res.json({ captured: true });
});
router.get("/capture", (req, res) => {
  res.json(lastPayload || { message: "No payload captured yet. Send a test webhook to /webhook/capture first." });
});

// Test endpoint to verify the webhook is reachable
router.get("/test", (req, res) => {
  res.json({
    status: "ok",
    webhook_url: `${req.protocol}://${req.get("host")}/webhook/inbound`,
    method: "POST",
    expected_payload: {
      contactId: "string (required)",
      message: "string (required)",
      locationId: "string (optional)",
    },
  });
});

module.exports = router;
