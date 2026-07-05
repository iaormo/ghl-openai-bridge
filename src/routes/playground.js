const express = require("express");
const {
  playgroundChat,
  setApiKey,
  getModel,
  setModel,
  tools,
  getManilaDateContext,
} = require("../services/openai");
const {
  createLocationCustomField,
  getLocationCustomFields,
  getContactInfo,
  updateContactInfo,
} = require("../services/contacts");
const { getLocationCalendars } = require("../services/calendar");
const { deleteHistory } = require("../db");
const { getBrain, reloadBrain, BRAIN_PATH } = require("../services/brain");
const fs = require("fs");

const router = express.Router();

// Runtime-added tools and custom fields (in-memory, persists for server lifetime)
const dynamicTools = [];
const customCalendars = [];
const customFields = [];
const removedBuiltinCalendarIds = new Set();
const removedBuiltinFieldKeys = new Set();

// GET /playground/config — current config
router.get("/config", async (req, res) => {
  try {
    res.json({
      model: getModel(),
      hasApiKey: !!process.env.OPENAI_API_KEY,
      hasGhlKey: !!process.env.GHL_API_KEY,
      // Full key values so the Settings tab can pre-fill them. NOTE: these come from
      // environment variables at runtime (never from committed code). Because the
      // playground has no password, anyone who loads it can read these — by owner's choice.
      openaiKey: process.env.OPENAI_API_KEY || "",
      ghlKey: process.env.GHL_API_KEY || "",
      systemPrompt: getBrain(),
      dateContext: getManilaDateContext(),
      calendarId: process.env.GHL_CALENDAR_ID || "hpj5HNU9F20BClTjiVTY",
      locationId: process.env.GHL_LOCATION_ID || "GfDBeSbJmjBtcqGK6vXN",
      timezone: process.env.GHL_TIMEZONE || "Asia/Manila",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /playground/brain — view the brain.md knowledge base (the system prompt)
router.get("/brain", (req, res) => {
  res.type("text/markdown").send(getBrain());
});

// POST /playground/brain — write brain.md and refresh the cache.
// Note: Railway's filesystem is ephemeral, so permanent edits should go through git.
router.post("/brain", (req, res) => {
  const { content } = req.body;
  if (typeof content !== "string") {
    return res.status(400).json({ error: "content must be a string" });
  }
  try {
    fs.writeFileSync(BRAIN_PATH, content, "utf8");
    const brain = reloadBrain();
    res.json({ success: true, length: brain.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /playground/brain/reload — re-read brain.md from disk (after a git deploy)
router.post("/brain/reload", (req, res) => {
  const brain = reloadBrain();
  res.json({ success: true, length: brain.length });
});

// DELETE /playground/history/:contactId — wipe the bot's stored conversation memory for a
// contact (fresh start). Useful after test messages or to reset a thread.
router.delete("/history/:contactId", async (req, res) => {
  try {
    const result = await deleteHistory(req.params.contactId);
    res.json({ success: true, contactId: req.params.contactId, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /playground/tools — list all tools (built-in + dynamic)
router.get("/tools", (req, res) => {
  const allTools = [
    ...tools.map((t) => ({ ...t.function, builtin: true })),
    ...dynamicTools.map((t) => ({ ...t, builtin: false })),
  ];
  res.json(allTools);
});

// POST /playground/tools — add a new tool definition
router.post("/tools", (req, res) => {
  const { name, description, parameters } = req.body;
  if (!name || !description) {
    return res.status(400).json({ error: "name and description are required" });
  }
  // Check for duplicates
  const exists = tools.some((t) => t.function.name === name) ||
    dynamicTools.some((t) => t.name === name);
  if (exists) {
    return res.status(409).json({ error: `Tool "${name}" already exists` });
  }
  const tool = {
    name,
    description,
    parameters: parameters || { type: "object", properties: {} },
  };
  dynamicTools.push(tool);
  // Also add to the OpenAI tools array so it's usable in chat
  tools.push({
    type: "function",
    function: tool,
  });
  res.json({ success: true, tool });
});

// PUT /playground/tools/:name — update a tool's description and/or parameters
router.put("/tools/:name", (req, res) => {
  const { name } = req.params;
  const { description, parameters } = req.body;
  // Find in the OpenAI tools array (covers both built-in and dynamic)
  const tool = tools.find((t) => t.function.name === name);
  if (!tool) {
    return res.status(404).json({ error: `Tool "${name}" not found` });
  }
  if (description !== undefined) tool.function.description = description;
  if (parameters !== undefined) tool.function.parameters = parameters;
  // Also update in dynamicTools if it's there
  const dynTool = dynamicTools.find((t) => t.name === name);
  if (dynTool) {
    if (description !== undefined) dynTool.description = description;
    if (parameters !== undefined) dynTool.parameters = parameters;
  }
  res.json({ success: true, tool: tool.function });
});

// DELETE /playground/tools/:name — remove a dynamic tool
router.delete("/tools/:name", (req, res) => {
  const { name } = req.params;
  const idx = dynamicTools.findIndex((t) => t.name === name);
  if (idx === -1) {
    return res.status(404).json({ error: `Dynamic tool "${name}" not found` });
  }
  dynamicTools.splice(idx, 1);
  // Remove from OpenAI tools array too
  const toolIdx = tools.findIndex((t) => t.function.name === name);
  if (toolIdx !== -1) tools.splice(toolIdx, 1);
  res.json({ success: true });
});

// POST /playground/chat — playground chat with overrides
router.post("/chat", async (req, res) => {
  try {
    const {
      contactId = "playground-test",
      message,
      temperature,
      top_p,
      max_tokens,
      model,
      systemPromptOverride,
      enabledTools,
    } = req.body;

    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const result = await playgroundChat(contactId, message, {
      temperature: temperature !== undefined ? parseFloat(temperature) : undefined,
      top_p: top_p !== undefined ? parseFloat(top_p) : undefined,
      max_tokens: max_tokens ? parseInt(max_tokens) : 1000,
      model,
      systemPromptOverride,
      enabledTools,
    });

    res.json(result);
  } catch (err) {
    console.error("Playground chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /playground/calendars — list built-in + synced calendars
router.get("/calendars", (req, res) => {
  const builtinCals = [
    {
      id: process.env.GHL_CALENDAR_ID || "hpj5HNU9F20BClTjiVTY",
      name: "ScalePlus Audit Calls",
      description: "Default calendar",
      source: "builtin",
    },
  ].filter((c) => !removedBuiltinCalendarIds.has(c.id));
  const builtinIds = new Set(builtinCals.map((c) => c.id));
  const extras = customCalendars.filter((c) => !builtinIds.has(c.id));
  res.json([...builtinCals, ...extras]);
});

// GET /playground/calendars/ghl — fetch all calendars from GHL for import selection
router.get("/calendars/ghl", async (req, res) => {
  try {
    const cals = await getLocationCalendars();
    res.json(cals);
  } catch (err) {
    console.error("Failed to fetch GHL calendars:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /playground/calendars/sync — sync selected calendars from GHL
router.post("/calendars/sync", (req, res) => {
  const { calendars } = req.body;
  if (!Array.isArray(calendars) || !calendars.length) {
    return res.status(400).json({ error: "calendars array is required" });
  }
  for (const cal of calendars) {
    if (!cal.id || !cal.name) continue;
    const exists = customCalendars.some((c) => c.id === cal.id);
    if (!exists) {
      customCalendars.push({
        id: cal.id,
        name: cal.name,
        description: cal.description || "",
        source: "ghl",
      });
    }
  }
  res.json({ success: true, synced: customCalendars });
});

// DELETE /playground/calendars/:id — remove a calendar (built-in or synced)
router.delete("/calendars/:id", (req, res) => {
  const { id } = req.params;
  const idx = customCalendars.findIndex((c) => c.id === id);
  if (idx !== -1) {
    customCalendars.splice(idx, 1);
  }
  removedBuiltinCalendarIds.add(id);
  res.json({ success: true });
});

// GET /playground/custom-fields — list built-in + synced custom fields
router.get("/custom-fields", (req, res) => {
  const builtinFields = [
    { key: "business_name", description: "The lead's company or business name", source: "builtin" },
    { key: "industry", description: "Industry or type of business", source: "builtin" },
    { key: "team_size", description: "Number of people on their team", source: "builtin" },
    { key: "current_tools", description: "CRM/tools/systems they currently use", source: "builtin" },
    { key: "pain_points", description: "Biggest manual bottleneck / time sink", source: "builtin" },
    { key: "service_interest", description: "What they want (chatbot, automation, CRM, custom build, CRM trial)", source: "builtin" },
    { key: "budget_timeline", description: "Budget comfort and desired start timeline", source: "builtin" },
    { key: "lead_status", description: "Funnel stage: new, qualified, audit_booked, follow_up, not_a_fit", source: "builtin" },
  ].filter((f) => !removedBuiltinFieldKeys.has(f.key));
  const builtinKeys = new Set(builtinFields.map((f) => f.key));
  const extras = customFields.filter((f) => !builtinKeys.has(f.key));
  res.json([...builtinFields, ...extras]);
});

// DELETE /playground/custom-fields/:key — remove a custom field (built-in or synced)
router.delete("/custom-fields/:key", (req, res) => {
  const { key } = req.params;
  const idx = customFields.findIndex((f) => f.key === key);
  if (idx !== -1) {
    customFields.splice(idx, 1);
  }
  removedBuiltinFieldKeys.add(key);
  res.json({ success: true });
});

// GET /playground/custom-fields/ghl — fetch all custom fields from GHL for import selection
router.get("/custom-fields/ghl", async (req, res) => {
  try {
    const fields = await getLocationCustomFields();
    res.json(
      fields.map((f) => ({
        id: f.id,
        key: f.fieldKey || f.name,
        name: f.name,
        dataType: f.dataType || "TEXT",
      }))
    );
  } catch (err) {
    console.error("Failed to fetch GHL custom fields:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /playground/custom-fields/sync — sync selected fields from GHL
router.post("/custom-fields/sync", (req, res) => {
  const { fields } = req.body;
  if (!Array.isArray(fields) || !fields.length) {
    return res.status(400).json({ error: "fields array is required" });
  }
  for (const f of fields) {
    if (!f.key || !f.name) continue;
    const exists = customFields.some((cf) => cf.key === f.key);
    if (!exists) {
      customFields.push({
        key: f.key,
        description: f.name,
        ghlId: f.id,
        dataType: f.dataType || "TEXT",
        source: "ghl",
      });
      // Also update the updateCustomField tool description
      const ucfTool = tools.find((t) => t.function.name === "updateCustomField");
      if (ucfTool) {
        ucfTool.function.description += `\n- '${f.key}' — ${f.name}`;
      }
    }
  }
  res.json({ success: true, synced: customFields });
});

// POST /playground/custom-fields — add a custom field in GHL and update the tool description
router.post("/custom-fields", async (req, res) => {
  const { key, description, dataType } = req.body;
  if (!key || !description) {
    return res.status(400).json({ error: "key and description are required" });
  }
  const exists = customFields.some((f) => f.key === key);
  if (exists) {
    return res.status(409).json({ error: `Custom field "${key}" already exists` });
  }

  try {
    // Create the field in GHL location
    const ghlField = await createLocationCustomField(key, dataType || "TEXT");

    customFields.push({
      key,
      description,
      builtin: false,
      ghlId: ghlField.id,
    });

    // Update the updateCustomField tool description to include this new key
    const ucfTool = tools.find((t) => t.function.name === "updateCustomField");
    if (ucfTool) {
      ucfTool.function.description += `\n- '${key}' — ${description}`;
    }

    res.json({ success: true, field: { key, description, ghlId: ghlField.id } });
  } catch (err) {
    console.error("Failed to create GHL custom field:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /playground/settings/ghl-key — update GHL API key at runtime
router.post("/settings/ghl-key", (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) {
    return res.status(400).json({ error: "API key is required" });
  }
  process.env.GHL_API_KEY = apiKey;
  res.json({ success: true });
});

// POST /playground/settings/ghl-location — update GHL Location ID at runtime
router.post("/settings/ghl-location", (req, res) => {
  const { locationId } = req.body;
  if (!locationId) {
    return res.status(400).json({ error: "Location ID is required" });
  }
  process.env.GHL_LOCATION_ID = locationId;
  res.json({ success: true });
});

// POST /playground/settings/api-key — update OpenAI API key at runtime
router.post("/settings/api-key", (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || !apiKey.startsWith("sk-")) {
    return res.status(400).json({ error: "Invalid API key format (must start with sk-)" });
  }
  try {
    setApiKey(apiKey);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /playground/settings/model — set the default model used for chats (runtime).
// Temperature/top_p are applied per-request from the Playground; they aren't persisted here.
router.post("/settings/model", (req, res) => {
  const { model } = req.body;
  if (!model) {
    return res.status(400).json({ error: "model is required" });
  }
  setModel(model);
  res.json({ success: true, model: getModel() });
});

// GET /playground/contact/:id — fetch a contact from GHL
router.get("/contact/:id", async (req, res) => {
  try {
    const contact = await getContactInfo(req.params.id);
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /playground/contact/:id — update a contact in GHL
router.put("/contact/:id", async (req, res) => {
  try {
    const result = await updateContactInfo(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
