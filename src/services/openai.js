const OpenAI = require("openai");
const { getHistory, saveMessage } = require("../db");
const {
  getAvailableSlots,
  bookAppointment,
  getContactAppointments,
  rescheduleAppointment,
  cancelAppointment,
  TIMEZONE,
} = require("./calendar");
const {
  getContactInfo,
  updateContactInfo,
  updateCustomField,
} = require("./contacts");

let openai = null;
let systemPrompt = null;

function getClient() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

// Allow runtime API key override
function setApiKey(apiKey) {
  process.env.OPENAI_API_KEY = apiKey;
  openai = new OpenAI({ apiKey });
  console.log("OpenAI API key updated at runtime");
}

// Allow runtime assistant ID override — re-fetches instructions
async function setAssistantId(assistantId) {
  process.env.OPENAI_ASSISTANT_ID = assistantId;
  systemPrompt = null; // clear cache so it re-fetches
  const prompt = await getSystemPrompt();
  console.log("Assistant ID updated to:", assistantId);
  return prompt;
}

// Fetch the assistant's instructions once and cache them
async function getSystemPrompt() {
  if (systemPrompt) return systemPrompt;

  try {
    const assistant = await getClient().beta.assistants.retrieve(
      process.env.OPENAI_ASSISTANT_ID
    );
    systemPrompt = assistant.instructions || "You are a helpful assistant.";
    console.log("Loaded assistant instructions (cached)");
  } catch (err) {
    console.warn("Could not fetch assistant instructions:", err.message);
    systemPrompt = "You are a helpful assistant.";
  }

  return systemPrompt;
}

// All OpenAI function tool definitions
const tools = [
  {
    type: "function",
    function: {
      name: "getCurrentDate",
      description: "Get the current date and time in Manila timezone (UTC+8). Call this at the start of a conversation.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "getContactInformation",
      description: "Retrieve the customer's existing contact information (name, phone, email, tags, custom fields) from the system.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "updateContactInfo",
      description: "Update the customer's name and/or phone number. MUST be called immediately when a customer provides their name or phone number.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Customer's full name" },
          phone: { type: "string", description: "Customer's phone number (e.g. 09171234567)" },
          email: { type: "string", description: "Customer's email address" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updateCustomField",
      description: `Update a custom field on the contact record. Available custom field keys:
- 'availed_service' — service(s) the customer availed or is interested in
- 'product_interest' — product(s) customer is interested in (e.g. AquaSkin Glutathione, Kaizen C+)
- 'order_quantity' — quantity and breakdown (e.g. '4 bottles Glutathione + 1 free + 2 Kaizen C+')
- 'order_total' — total order amount (e.g. '₱6,920')
- 'payment_method' — payment method chosen (GCash or COD)
- 'shipping_address' — complete delivery address
- 'order_status' — order status (pending, paid, shipped, delivered)
- 'payment_reference' — GCash reference number after payment
Call this to save order details whenever the customer confirms an order, provides payment info, or gives their address.`,
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The custom field key (see description for available keys)" },
          value: { type: "string", description: "The value to set" },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getProductCatalog",
      description: "Get the full product catalog with pricing, promotions, and payment information. Call this when a customer asks about products, prices, or how to order.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "getAvailableSlots",
      description: "Check available appointment time slots for a specific date. Returns all open 30-minute slots.",
      parameters: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Date in YYYY-MM-DD format" },
          end_date: { type: "string", description: "End date in YYYY-MM-DD format (optional, defaults to start_date)" },
        },
        required: ["start_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "appointmentBooking",
      description: "Book an appointment for the customer. Requires contact name, phone, service, date and time. Only call after the customer confirms the slot.",
      parameters: {
        type: "object",
        properties: {
          date_time: { type: "string", description: "Appointment date and time in ISO format (e.g. 2026-03-08T14:00:00+08:00)" },
          service: { type: "string", description: "The service being booked" },
          customer_name: { type: "string", description: "Customer's name for the appointment title" },
          phone: { type: "string", description: "Customer's phone number" },
        },
        required: ["date_time", "service"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getContactAppointments",
      description: "Get the customer's upcoming appointments. Use for reschedule or cancellation requests.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "rescheduleAppointment",
      description: "Reschedule an existing appointment to a new date/time.",
      parameters: {
        type: "object",
        properties: {
          appointment_id: { type: "string", description: "The appointment ID to reschedule" },
          new_date_time: { type: "string", description: "New date and time in ISO format" },
        },
        required: ["appointment_id", "new_date_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancelAppointment",
      description: "Cancel an existing appointment.",
      parameters: {
        type: "object",
        properties: {
          appointment_id: { type: "string", description: "The appointment ID to cancel" },
        },
        required: ["appointment_id"],
      },
    },
  },
];

// Execute a tool call
async function executeTool(toolCall, contactId) {
  const name = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments || "{}");

  try {
    switch (name) {
      case "getCurrentDate": {
        const now = new Date().toLocaleString("en-PH", {
          timeZone: TIMEZONE,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        return JSON.stringify({ currentDate: now, timezone: TIMEZONE });
      }

      case "getContactInformation": {
        const info = await getContactInfo(contactId);
        return JSON.stringify(info);
      }

      case "updateContactInfo": {
        const result = await updateContactInfo(contactId, args);
        return JSON.stringify(result);
      }

      case "updateCustomField": {
        const result = await updateCustomField(contactId, args.key, args.value);
        return JSON.stringify(result);
      }

      case "getProductCatalog": {
        return JSON.stringify({
          products: [
            {
              name: "AquaSkin Premium Glutathione",
              price: 1455,
              currency: "PHP",
              price_display: "₱1,455 per bottle",
              description: "Japanese FDA-approved supplement trusted by 500+ Cebu clients",
              benefits: ["Skin brightening/whitening", "Antioxidant defense", "Promotes restful sleep", "Youthful glow"],
              how_to_use: "1-2 capsules before bedtime",
              fda_registration: "#4000006996192",
            },
            {
              name: "AquaSkin Kaizen C+ (30 capsules)",
              price: 550,
              currency: "PHP",
              price_display: "₱550 per bottle",
              description: "First-ever Japan non-acidic Vitamin C in frosted glass bottle with 10-in-1 premium ingredients",
              unique_features: ["100% Made in Japan", "Non-irritating even on empty stomach", "Japanese desiccant inside bottle", "Classy frosted glass packaging"],
              benefits: ["High antioxidant & Vitamin C", "Natural anti-inflammatory", "Immune system support", "Helps regulate insulin", "Aids in red-blood-cell formation & anemia prevention", "May reduce cholesterol/blood sugar/risk of heart disease or cancer", "Promotes overall growth & development", "Helps with PCOS"],
              key_ingredients: ["Rosehips", "Sodium Ascorbate", "Curcumin", "Quercetin", "Beta Glucan", "Zinc Gluconate", "Turmeric", "Vitamin B6", "Vitamin B12", "Inositol"],
            },
          ],
          promotions: [
            { name: "Buy 4 Get 1 Free", description: "For every 4 bottles of Glutathione purchased, 1 additional bottle is included free", applies_to: "AquaSkin Glutathione" },
            { name: "Free Shipping (Cebu only)", description: "Orders of 2 or more bottles get free shipping within Cebu" },
            { name: "Upsell Pairing", description: "Kaizen C+ is positioned as a complement to Glutathione for enhanced whitening and health results" },
          ],
          payment: {
            gcash: { number: "09178092224", account_name: "Lory Mae Ormo", display_name: "LO.Y M.. O." },
            cod: { available: true, area: "Cebu addresses only" },
            outside_cebu: "Team confirms courier options and shipping fee separately before providing final total and payment instructions",
          },
          pricing_guide: {
            glutathione_1: "₱1,455",
            glutathione_2: "₱2,910 (free shipping in Cebu)",
            glutathione_4: "₱5,820 (+ 1 FREE bottle, free shipping in Cebu)",
            kaizen_1: "₱550",
            kaizen_2: "₱1,100 (free shipping in Cebu)",
          },
        });
      }

      case "getAvailableSlots": {
        const endDate = args.end_date || args.start_date;
        const slots = await getAvailableSlots(args.start_date, endDate);
        return JSON.stringify(slots);
      }

      case "appointmentBooking": {
        const title = `${args.customer_name || "Customer"} x Breys - ${args.service}`;
        const result = await bookAppointment(contactId, args.date_time, title);
        return JSON.stringify({ success: true, appointmentId: result.id || result.appointmentId, ...result });
      }

      case "getContactAppointments": {
        const appts = await getContactAppointments(contactId);
        return JSON.stringify(appts);
      }

      case "rescheduleAppointment": {
        const result = await rescheduleAppointment(args.appointment_id, args.new_date_time);
        return JSON.stringify({ success: true, ...result });
      }

      case "cancelAppointment": {
        const result = await cancelAppointment(args.appointment_id);
        return JSON.stringify({ success: true, ...result });
      }

      default:
        return JSON.stringify({ error: `Unknown function: ${name}` });
    }
  } catch (err) {
    console.error(`Tool ${name} error:`, err.message);
    return JSON.stringify({ error: err.message });
  }
}

// Get current Manila date/time string to inject into every request
function getManilaDateContext() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-PH", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-PH", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  // Also compute upcoming day-of-week references
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    days.push(
      `${d.toLocaleDateString("en-PH", { weekday: "long", timeZone: TIMEZONE })} = ${d.toLocaleDateString("en-PH", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIMEZONE })}`
    );
  }
  return `\n\nCURRENT DATE/TIME (Manila, UTC+8): ${dateStr}, ${timeStr}\nUpcoming days:\n${days.join("\n")}`;
}

async function chat(contactId, message) {
  const [instructions, history] = await Promise.all([
    getSystemPrompt(),
    getHistory(contactId, 20),
  ]);

  // Inject fresh Manila date context into every request
  const systemContent = instructions + getManilaDateContext();

  const messages = [
    { role: "system", content: systemContent },
    ...history,
    { role: "user", content: message },
  ];

  let response = await getClient().chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    tools,
    max_tokens: 1000,
  });

  let choice = response.choices[0];

  // Handle tool calls (up to 5 rounds for multi-step flows)
  let rounds = 0;
  while (choice.finish_reason === "tool_calls" && rounds < 5) {
    rounds++;
    const toolCalls = choice.message.tool_calls;
    messages.push(choice.message);

    for (const tc of toolCalls) {
      console.log(`Tool: ${tc.function.name}(${tc.function.arguments})`);
      const result = await executeTool(tc, contactId);
      console.log(`Result: ${result.slice(0, 200)}`);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }

    response = await getClient().chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      tools,
      max_tokens: 1000,
    });
    choice = response.choices[0];
  }

  const reply = choice.message?.content;
  if (!reply) throw new Error("No reply from OpenAI");

  await Promise.all([
    saveMessage(contactId, "user", message),
    saveMessage(contactId, "assistant", reply),
  ]);

  return reply;
}

// Playground chat — accepts overrides for temperature, top_p, max_tokens, model
// Returns { reply, toolCalls } where toolCalls is the full trace
async function playgroundChat(contactId, message, opts = {}) {
  const {
    temperature,
    top_p,
    max_tokens = 1000,
    model,
    systemPromptOverride,
    enabledTools,
  } = opts;

  const [instructions, history] = await Promise.all([
    getSystemPrompt(),
    getHistory(contactId, 20),
  ]);

  const systemContent = (systemPromptOverride || instructions) + getManilaDateContext();

  const messages = [
    { role: "system", content: systemContent },
    ...history,
    { role: "user", content: message },
  ];

  // Filter tools if enabledTools is specified
  const activeTools = enabledTools
    ? tools.filter((t) => enabledTools.includes(t.function.name))
    : tools;

  const params = {
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    tools: activeTools.length ? activeTools : undefined,
    max_tokens,
  };
  if (temperature !== undefined) params.temperature = temperature;
  if (top_p !== undefined) params.top_p = top_p;

  let response = await getClient().chat.completions.create(params);
  let choice = response.choices[0];

  const toolTrace = [];
  let rounds = 0;

  while (choice.finish_reason === "tool_calls" && rounds < 5) {
    rounds++;
    const toolCalls = choice.message.tool_calls;
    messages.push(choice.message);

    for (const tc of toolCalls) {
      console.log(`Tool: ${tc.function.name}(${tc.function.arguments})`);
      const result = await executeTool(tc, contactId);
      console.log(`Result: ${result.slice(0, 200)}`);
      toolTrace.push({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || "{}"),
        result: JSON.parse(result),
      });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }

    params.messages = messages;
    response = await getClient().chat.completions.create(params);
    choice = response.choices[0];
  }

  const reply = choice.message?.content;
  if (!reply) throw new Error("No reply from OpenAI");

  await Promise.all([
    saveMessage(contactId, "user", message),
    saveMessage(contactId, "assistant", reply),
  ]);

  return {
    reply,
    toolCalls: toolTrace,
    model: params.model,
    usage: response.usage,
  };
}

module.exports = {
  chat,
  playgroundChat,
  getSystemPrompt,
  getClient,
  setApiKey,
  setAssistantId,
  tools,
  executeTool,
  getManilaDateContext,
};
