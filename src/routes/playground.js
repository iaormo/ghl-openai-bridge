const express = require("express");
const {
  playgroundChat,
  getSystemPrompt,
  getClient,
  setApiKey,
  setAssistantId,
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
    const systemPrompt = await getSystemPrompt();
    res.json({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      assistantId: process.env.OPENAI_ASSISTANT_ID || "",
      hasApiKey: !!process.env.OPENAI_API_KEY,
      hasGhlKey: !!process.env.GHL_API_KEY,
      systemPrompt,
      dateContext: getManilaDateContext(),
      calendarId: process.env.GHL_CALENDAR_ID || "6ZLEA0dTsCE67OOAmQnU",
      locationId: process.env.GHL_LOCATION_ID || "JYNTUGxvUZVoROmjpf50",
      timezone: process.env.GHL_TIMEZONE || "Asia/Manila",
    });
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
      id: process.env.GHL_CALENDAR_ID || "6ZLEA0dTsCE67OOAmQnU",
      name: "Breys Minglanilla",
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
    { key: "availed_service", description: "Service(s) the customer availed", source: "builtin" },
    { key: "product_interest", description: "Product(s) customer is interested in", source: "builtin" },
    { key: "order_quantity", description: "Quantity and breakdown", source: "builtin" },
    { key: "order_total", description: "Total order amount", source: "builtin" },
    { key: "payment_method", description: "Payment method (GCash or COD)", source: "builtin" },
    { key: "shipping_address", description: "Complete delivery address", source: "builtin" },
    { key: "order_status", description: "Order status", source: "builtin" },
    { key: "payment_reference", description: "GCash reference number", source: "builtin" },
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

// POST /playground/settings/assistant-id — change assistant and reload prompt
router.post("/settings/assistant-id", async (req, res) => {
  const { assistantId } = req.body;
  if (!assistantId || !assistantId.startsWith("asst_")) {
    return res.status(400).json({ error: "Invalid Assistant ID format (must start with asst_)" });
  }
  try {
    const systemPrompt = await setAssistantId(assistantId);
    res.json({ success: true, systemPrompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /playground/settings/prompt — save prompt to the OpenAI assistant
router.post("/settings/prompt", async (req, res) => {
  const { instructions } = req.body;
  if (typeof instructions !== "string") {
    return res.status(400).json({ error: "instructions must be a string" });
  }
  try {
    const client = getClient();
    const assistantId = process.env.OPENAI_ASSISTANT_ID;
    if (!assistantId) {
      return res.status(400).json({ error: "No OPENAI_ASSISTANT_ID configured" });
    }
    await client.beta.assistants.update(assistantId, { instructions });
    // Also update the cached prompt via setAssistantId (re-fetches)
    await setAssistantId(assistantId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /playground/settings/model — save model settings to the OpenAI assistant
router.post("/settings/model", async (req, res) => {
  const { model, temperature, top_p } = req.body;
  try {
    const client = getClient();
    const assistantId = process.env.OPENAI_ASSISTANT_ID;
    if (!assistantId) {
      return res.status(400).json({ error: "No OPENAI_ASSISTANT_ID configured" });
    }
    const update = {};
    if (model) update.model = model;
    if (temperature !== undefined) update.temperature = parseFloat(temperature);
    if (top_p !== undefined) update.top_p = parseFloat(top_p);
    await client.beta.assistants.update(assistantId, update);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /playground/assistant — fetch assistant details from OpenAI
router.get("/assistant", async (req, res) => {
  try {
    const client = getClient();
    const assistant = await client.beta.assistants.retrieve(
      process.env.OPENAI_ASSISTANT_ID
    );
    res.json({
      id: assistant.id,
      name: assistant.name,
      model: assistant.model,
      instructions: assistant.instructions,
      tools: assistant.tools,
      temperature: assistant.temperature,
      top_p: assistant.top_p,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
