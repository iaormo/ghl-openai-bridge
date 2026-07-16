require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { initDB } = require("./db");
const webhookRoutes = require("./routes/webhook");
const playgroundRoutes = require("./routes/playground");
const gmail = require("./services/gmail");
const reminders = require("./services/reminders");
const outreach = require("./services/outreach");
const nurture = require("./services/nurture");
const suppression = require("./services/suppression");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, "..", "public")));

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    service: "GHL-OpenAI Bridge",
    status: "running",
    webhook: `${req.protocol}://${req.get("host")}/webhook/inbound`,
  });
});

// Keep legacy health check
app.get("/health", (req, res) => {
  res.json({ service: "GHL-OpenAI Bridge", status: "running" });
});

// Webhook routes
app.use("/webhook", webhookRoutes);

// Playground API routes
app.use("/playground", playgroundRoutes);

// --- Gmail OAuth (self-service connect for ian@scaleplus.io) ---
app.get("/oauth/gmail/start", (req, res) => {
  if (!process.env.GMAIL_CLIENT_ID) return res.status(400).send("Set GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET first.");
  res.redirect(gmail.consentUrl());
});
app.get("/oauth/gmail/callback", async (req, res) => {
  try {
    if (req.query.error) return res.status(400).send(`Google returned an error: ${req.query.error}`);
    if (!req.query.code) return res.status(400).send("Missing authorization code.");
    await gmail.exchangeCode(req.query.code);
    res.send("✅ Gmail connected! Skye will now reply to inbound emails in your scoped label. You can close this tab.");
  } catch (err) {
    res.status(500).send(`Gmail connect failed: ${err.message}`);
  }
});

// Start server
async function start() {
  await initDB();
  await suppression.initSuppression(); // before outreach/nurture — every send path depends on it
  await outreach.initOutreach();
  await nurture.initNurture();
  app.listen(PORT, () => {
    console.log(`Bridge server running on port ${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/webhook/inbound`);
    console.log(`Test endpoint: http://localhost:${PORT}/webhook/test`);
    gmail.startGmailPoller(60000);
    reminders.startReminderScheduler(5 * 60 * 1000);
    outreach.startOutreachScheduler(10 * 60 * 1000);
    nurture.startNurtureScheduler(30 * 60 * 1000);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
