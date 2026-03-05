const express = require("express");
const { chat } = require("../services/openai");
const { sendReply } = require("../services/ghl");

const router = express.Router();

// Track recently processed messages to prevent duplicates
const processed = new Map();
const DEDUP_TTL = 60_000; // 60 seconds

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

    // --- EXTRACT PAYLOAD ---
    const contactId = body.contactId || body.contact_id || body.contact?.id;
    const message =
      body.message ||
      body.body ||
      body.messageBody ||
      body.payload?.message?.body;
    const locationId = body.locationId || body.location_id;

    if (!contactId || !message) {
      return res.status(400).json({
        error: "Missing contactId or message",
        received: { contactId, message },
        hint: "Webhook payload must include contactId and message fields",
      });
    }

    console.log(`Incoming message from contact ${contactId}: ${message}`);

    // Respond immediately so GHL doesn't timeout or retry
    res.json({ success: true, contactId, status: "processing" });

    // --- PROCESS ASYNC (after response sent) ---
    const reply = await chat(contactId, message);
    console.log(`AI reply for contact ${contactId}: ${reply}`);

    if (process.env.GHL_API_KEY) {
      await sendReply(contactId, reply, locationId);
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
