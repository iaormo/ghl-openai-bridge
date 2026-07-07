const express = require("express");
const { chat, composeOutreach, composeReachinboxReengage, isPositiveReply } = require("../services/openai");
const { sendReply, sendReplyHuman, sendTypingIndicator, setChannelType, setChannel, detectChannel, setEmailMeta, captureEmailThread, getChannelType } = require("../services/ghl");
const { sendSms, parseInboundSms } = require("../services/sms");
const { upsertContactByPhone, upsertContactByEmail, createContactNote } = require("../services/contacts");

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

// Derive a rep's display name from their ReachInbox sending mailbox (the "derive from email"
// choice). "sarah.cruz@scaleplus.io" -> "Sarah Cruz", "jm@scaleplus.io" -> "Jm". Optional exact
// overrides via REACHINBOX_REP_NAMES="sarah@x.io:Sarah Cruz,jm@x.io:JM Reyes" for generic mailboxes.
function repNameFromEmail(email) {
  if (!email) return "";
  const addr = String(email).trim().toLowerCase();
  for (const pair of (process.env.REACHINBOX_REP_NAMES || "").split(",")) {
    const [k, v] = pair.split(":");
    if (k && v && k.trim().toLowerCase() === addr) return v.trim();
  }
  const local = (addr.split("@")[0] || "").replace(/\+.*$/, "");
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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

    // For email, pull the real subject + thread id from GHL so the reply threads (Re: subject)
    if (channel === "Email") {
      await captureEmailThread(contactId, locationId);
    }

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
    setEmailMeta(contactId, { subject: "Thanks for reaching out to ScalePlus 👋", isReply: false });

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

// --- REACHINBOX: a lead replied to a rep's cold email -> if positive, Ian re-engages via GHL email ---
// Register in ReachInbox: Settings > Integrations > Webhooks, event REPLY_RECEIVED (and/or
// LEAD_INTERESTED), URL = https://<host>/webhook/reachinbox  (append ?token=... if you set
// REACHINBOX_WEBHOOK_TOKEN). Ian's email then hands off to the normal /inbound reply→booking loop.
router.post("/reachinbox", async (req, res) => {
  try {
    // Optional shared secret: if REACHINBOX_WEBHOOK_TOKEN is set, require a matching ?token=.
    const expected = process.env.REACHINBOX_WEBHOOK_TOKEN;
    if (expected && req.query.token !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const b = req.body || {};
    const event = b.event || b.eventType;
    const leadEmail = b.lead_email || b.leadEmail;
    const replyBody = b.email_replied_body || b.emailRepliedBody || b.reply_body || "";
    const firstName = b.lead_first_name || b.leadFirstName || "";
    const lastName = b.lead_last_name || b.leadLastName || "";
    const emailAccount = b.email_account || b.emailAccount || ""; // the rep's sending mailbox
    const campaignName = b.campaign_name || b.campaignName || "";
    const messageId = b.message_id || b.messageId;

    // Only act on a reply / interested event with a lead email; acknowledge everything else 200
    // so ReachInbox doesn't retry or disable the webhook.
    const actionable = event === "REPLY_RECEIVED" || event === "LEAD_INTERESTED";
    if (!actionable || !leadEmail) {
      return res.status(200).json({ skipped: true, reason: `ignored event ${event || "(none)"}` });
    }

    // Dedup so ReachInbox retries / duplicate events never double-send.
    if (isDuplicate(messageId || `ri:${leadEmail}:${String(replyBody).slice(0, 40)}`)) {
      return res.status(200).json({ skipped: true, reason: "duplicate" });
    }

    // Ack immediately so ReachInbox doesn't time out; do the real work async.
    res.status(200).json({ success: true, status: "processing", lead: leadEmail });

    const repName = repNameFromEmail(emailAccount);       // full name — for the team-facing note
    const repFirstName = repName.split(/\s+/)[0] || "";   // first name only — for the email copy

    // LEAD_INTERESTED is already vetted by ReachInbox. For a raw REPLY_RECEIVED, run our own
    // positive-sentiment gate so we never chase a "not interested" / unsubscribe / auto-reply.
    if (event === "REPLY_RECEIVED") {
      const positive = await isPositiveReply(campaignName, replyBody);
      if (!positive) {
        console.log(`ReachInbox: skipped ${leadEmail} — reply not positive`);
        return;
      }
    }

    // Enrich from the full ReachInbox lead record (the webhook omits it): LinkedIn, phone, company,
    // website — so the GHL contact we create is complete, not just an email + name.
    let lf = {};
    try {
      const reachinbox = require("../services/reachinbox");
      const lead = await reachinbox.getLeadDetails({
        campaignId: b.campaign_id || b.campaignId,
        id: b.lead_id || b.leadId,
        email: leadEmail,
      });
      if (lead) lf = reachinbox.extractContactFields(lead);
    } catch (e) { console.warn("ReachInbox lead enrichment failed:", e.message); }

    // GHL contact (with email + LinkedIn + phone/company) so booking/notes/memory + the normal
    // inbound reply loop all work.
    const fullName = `${firstName || lf.firstName} ${lastName || lf.lastName}`.trim();
    let contactId = null;
    try {
      contactId = await upsertContactByEmail(leadEmail, fullName, {
        linkedin: lf.linkedin,
        phone: lf.phone,
        companyName: lf.companyName,
        website: lf.website,
      });
    } catch (e) { console.warn("ReachInbox contact upsert failed:", e.message); }
    const convId = contactId || `reachinbox:${leadEmail}`;
    if (contactId) console.log(`ReachInbox: GHL contact ${contactId} — email=${leadEmail} linkedin=${lf.linkedin || "(none)"}`);

    // Log the lead's actual reply as a note on the contact, so the team has the full context.
    if (contactId && replyBody) {
      const note =
        `💬 REACHINBOX POSITIVE REPLY\n` +
        `Campaign: ${campaignName || "(unknown)"}\n` +
        `Rep: ${repName || "(unknown)"}${emailAccount ? ` <${emailAccount}>` : ""}\n` +
        (lf.linkedin ? `LinkedIn: ${lf.linkedin}\n` : "") +
        `\nWhat they replied:\n"${String(replyBody).trim()}"`;
      try { await createContactNote(contactId, note); }
      catch (e) { console.warn("ReachInbox note creation failed (non-fatal):", e.message); }
    }

    // Send as a fresh Ian email through GHL (a new first-touch, not a threaded in-place reply).
    if (contactId) {
      setChannel(contactId, "Email");
      // emailFrom drives payload.emailTo in ghl.sendReply, so this delivers to the lead.
      setEmailMeta(contactId, { isReply: false, emailFrom: leadEmail, subject: "A note from Ian at ScalePlus" });
    }

    const email = await composeReachinboxReengage(convId, { firstName, repName: repFirstName, replyBody, campaignName });
    if (email && process.env.GHL_API_KEY && contactId) {
      await sendReply(contactId, email);
      console.log(`ReachInbox: Ian re-engaged ${leadEmail} (rep "${repName || "?"}", campaign "${campaignName}")`);
    } else {
      console.warn(`ReachInbox: not sent for ${leadEmail} (hasEmail=${!!email} contactId=${contactId})`);
    }
  } catch (error) {
    console.error("ReachInbox webhook error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// --- SMS via Android gateway (Philippine number connected by webhook) ---
router.post("/sms", async (req, res) => {
  try {
    const body = req.body;
    console.log("INBOUND SMS RAW:", JSON.stringify(body).slice(0, 600));
    const { from, text, messageId } = parseInboundSms(body);
    if (!from || !text) {
      return res.status(200).json({ skipped: true, reason: "no from/text in payload" });
    }
    if (isDuplicate(messageId || `${from}|${text}`)) {
      return res.status(200).json({ skipped: true, reason: "duplicate" });
    }

    // Respond immediately so the gateway doesn't retry
    res.json({ success: true, status: "processing" });

    // Get a GHL contact for this phone (so booking/notes/memory work), then reply as SMS
    let contactId;
    try { contactId = await upsertContactByPhone(from); } catch (e) { console.error("SMS contact upsert failed:", e.message); }
    if (!contactId) { console.warn("No contactId for SMS from", from); return; }

    setChannel(contactId, "SMS");
    console.log(`Incoming SMS from ${from} (contact ${contactId}): ${text}`);

    const reply = await chat(contactId, text, "SMS");
    console.log(`AI SMS reply for ${from}: ${reply}`);
    await sendSms(from, reply);
    console.log(`SMS reply sent to ${from}`);
  } catch (error) {
    console.error("SMS webhook error:", error);
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

// Dry-run: what the Gmail poller WOULD do with current unread inbox mail — no sends, no changes.
router.get("/inspect-inbox", async (req, res) => {
  try {
    const gmail = require("../services/gmail");
    const out = await gmail.inspectInbox();
    res.json({ success: true, ...out });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// One-shot recovery: clear the "/Seen" marker from recent inbox mail so the poller re-checks it.
router.get("/gmail-reprocess", async (req, res) => {
  try {
    const gmail = require("../services/gmail");
    const out = await gmail.reprocessInbox();
    res.json({ success: true, ...out });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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
