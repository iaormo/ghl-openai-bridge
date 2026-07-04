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
const { getBrain } = require("./brain");

let openai = null;

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

function getModel() {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

// Allow runtime model override (used by the Playground)
function setModel(model) {
  if (model) process.env.OPENAI_MODEL = model;
  return getModel();
}

// All function tool definitions. Kept in the Chat-Completions "nested" shape so the
// Playground tool manager can read/write t.function.*; converted to the Responses API
// (flat) shape at call time via responsesTools().
const tools = [
  {
    type: "function",
    function: {
      name: "getCurrentDate",
      description: "Get the current date and time in Philippine time (UTC+8). Call this at the start of a conversation.",
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
          name: { type: "string", description: "Lead's full name" },
          phone: { type: "string", description: "Lead's phone number (with country code where relevant, e.g. +639171234567)" },
          email: { type: "string", description: "Lead's email address" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updateCustomField",
      description: `Update a custom field on the contact record to capture lead qualification info. Available custom field keys:
- 'business_name' — the lead's company or business name
- 'industry' — their industry or type of business (e.g. dental clinic, e-commerce, real estate)
- 'team_size' — number of people on their team, especially on repetitive work
- 'current_tools' — the CRM/tools/systems they currently use
- 'pain_points' — their biggest manual bottleneck or the thing eating their time
- 'service_interest' — what they want (chatbot, automation, CRM, custom build, or ScalePlus CRM trial)
- 'budget_timeline' — budget comfort and desired start timeline (only if it comes up naturally)
- 'lead_status' — funnel stage: one of 'new', 'qualified', 'audit_booked', 'follow_up', 'not_a_fit'
Call this whenever the lead shares qualification info (business details, pain points, tools, or timeline). Save each detail as it comes up.`,
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
      description: "Book the free automation audit / consultation call for the lead. Requires their name, the call topic, and the confirmed date and time. Only call after the lead confirms the slot.",
      parameters: {
        type: "object",
        properties: {
          date_time: { type: "string", description: "Appointment date and time in ISO format (e.g. 2026-03-08T14:00:00+08:00)" },
          service: { type: "string", description: "The topic of the call (e.g. 'Automation Audit — chatbot for dental clinic')" },
          customer_name: { type: "string", description: "Lead's name for the appointment title" },
          phone: { type: "string", description: "Lead's phone number" },
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

// Convert the internal tools registry to the Responses API (flat) function-tool shape.
function responsesTools(activeTools) {
  return activeTools.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

// Execute a single function call by name + raw JSON argument string.
async function runTool(name, argsString, contactId) {
  const args = JSON.parse(argsString || "{}");

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

      case "getAvailableSlots": {
        const endDate = args.end_date || args.start_date;
        const slots = await getAvailableSlots(args.start_date, endDate);
        return JSON.stringify(slots);
      }

      case "appointmentBooking": {
        const title = `${args.customer_name || "Lead"} x ScalePlus - ${args.service}`;
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
  return `\n\nCURRENT DATE/TIME (Dumaguete, Philippines — Philippine Time, UTC+8): ${dateStr}, ${timeStr}\nUpcoming days:\n${days.join("\n")}`;
}

// Build the system instructions: brain.md (persona + knowledge + playbooks) + fresh date context.
function buildInstructions(override) {
  const base = override != null ? override : getBrain();
  return base + getManilaDateContext();
}

// Normalize Responses API usage to the { prompt_tokens, completion_tokens, total_tokens } shape.
function normalizeUsage(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
  };
}

// Production chat — used by the GHL webhook. Uses the OpenAI Responses API.
async function chat(contactId, message) {
  const history = await getHistory(contactId, 20);
  const instructions = buildInstructions();
  const model = getModel();
  const toolDefs = responsesTools(tools);

  // Responses API input: prior turns + the new user message
  const input = [...history, { role: "user", content: message }];

  let response = await getClient().responses.create({
    model,
    instructions,
    input,
    tools: toolDefs,
    max_output_tokens: 1000,
    store: false,
  });

  // Handle tool calls (up to 5 rounds for multi-step flows)
  let rounds = 0;
  while (rounds < 5) {
    const calls = (response.output || []).filter((o) => o.type === "function_call");
    if (!calls.length) break;
    rounds++;

    // Echo the model's output (including the function_call items) back into the input
    input.push(...response.output);

    for (const call of calls) {
      console.log(`Tool: ${call.name}(${call.arguments})`);
      const result = await runTool(call.name, call.arguments, contactId);
      console.log(`Result: ${result.slice(0, 200)}`);
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: result,
      });
    }

    response = await getClient().responses.create({
      model,
      instructions,
      input,
      tools: toolDefs,
      max_output_tokens: 1000,
      store: false,
    });
  }

  const reply = response.output_text;
  if (!reply) throw new Error("No reply from OpenAI");

  await Promise.all([
    saveMessage(contactId, "user", message),
    saveMessage(contactId, "assistant", reply),
  ]);

  return reply;
}

// Playground chat — accepts overrides for temperature, top_p, max_tokens, model,
// systemPromptOverride, and enabledTools. Returns { reply, toolCalls, model, usage }.
async function playgroundChat(contactId, message, opts = {}) {
  const {
    temperature,
    top_p,
    max_tokens = 1000,
    model,
    systemPromptOverride,
    enabledTools,
  } = opts;

  const history = await getHistory(contactId, 20);
  const instructions = buildInstructions(systemPromptOverride ?? null);
  const activeModel = model || getModel();

  // Filter tools if enabledTools is specified
  const activeTools = enabledTools
    ? tools.filter((t) => enabledTools.includes(t.function.name))
    : tools;
  const toolDefs = responsesTools(activeTools);

  const input = [...history, { role: "user", content: message }];

  const params = {
    model: activeModel,
    instructions,
    input,
    tools: toolDefs.length ? toolDefs : undefined,
    max_output_tokens: max_tokens,
    store: false,
  };
  if (temperature !== undefined) params.temperature = temperature;
  if (top_p !== undefined) params.top_p = top_p;

  let response = await getClient().responses.create(params);

  const toolTrace = [];
  let rounds = 0;

  while (rounds < 5) {
    const calls = (response.output || []).filter((o) => o.type === "function_call");
    if (!calls.length) break;
    rounds++;

    input.push(...response.output);

    for (const call of calls) {
      console.log(`Tool: ${call.name}(${call.arguments})`);
      const result = await runTool(call.name, call.arguments, contactId);
      console.log(`Result: ${result.slice(0, 200)}`);
      toolTrace.push({
        name: call.name,
        arguments: JSON.parse(call.arguments || "{}"),
        result: JSON.parse(result),
      });
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: result,
      });
    }

    params.input = input;
    response = await getClient().responses.create(params);
  }

  const reply = response.output_text;
  if (!reply) throw new Error("No reply from OpenAI");

  await Promise.all([
    saveMessage(contactId, "user", message),
    saveMessage(contactId, "assistant", reply),
  ]);

  return {
    reply,
    toolCalls: toolTrace,
    model: activeModel,
    usage: normalizeUsage(response.usage),
  };
}

module.exports = {
  chat,
  playgroundChat,
  getClient,
  setApiKey,
  getModel,
  setModel,
  tools,
  runTool,
  getManilaDateContext,
};
