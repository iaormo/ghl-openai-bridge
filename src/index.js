require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { initDB } = require("./db");
const webhookRoutes = require("./routes/webhook");
const playgroundRoutes = require("./routes/playground");

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

// Start server
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`Bridge server running on port ${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/webhook/inbound`);
    console.log(`Test endpoint: http://localhost:${PORT}/webhook/test`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
