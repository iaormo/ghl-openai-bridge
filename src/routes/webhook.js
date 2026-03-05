const express = require("express");
const { chat } = require("../services/openai");
const { sendReply } = require("../services/ghl");

const router = express.Router();

router.post("/inbound", async (req, res) => {
  try {
    const body = req.body;

    // Extract contact ID and message from GHL webhook payload
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

    // Get AI response
    const reply = await chat(contactId, message);
    console.log(`AI reply for contact ${contactId}: ${reply}`);

    // Send reply back to GHL
    if (process.env.GHL_API_KEY) {
      await sendReply(contactId, reply, locationId);
      console.log(`Reply sent back to GHL for contact ${contactId}`);
    }

    res.json({
      success: true,
      contactId,
      reply,
    });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({
      error: "Failed to process webhook",
      message: error.message,
    });
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
