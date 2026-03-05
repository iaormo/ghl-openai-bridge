const OpenAI = require("openai");
const { getHistory, saveMessage } = require("../db");
const { getAvailableSlots, bookAppointment, TIMEZONE } = require("./calendar");

let openai = null;
let systemPrompt = null;

function getClient() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
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

  // Append calendar context
  const today = new Date().toLocaleDateString("en-PH", { timeZone: TIMEZONE });
  systemPrompt += `\n\nIMPORTANT CALENDAR INFO:
- Today's date is ${today}. Timezone is ${TIMEZONE} (Asia/Manila).
- You can check available appointment slots and book appointments.
- When a customer wants to book, first ask what service and preferred date.
- Then call check_available_slots to show them open times.
- Once they pick a time, call book_appointment to confirm.
- Always confirm the date, time and service before booking.
- Use 24-hour ISO format for dates (e.g. 2026-03-08).`;

  return systemPrompt;
}

// OpenAI function definitions for calendar
const tools = [
  {
    type: "function",
    function: {
      name: "check_available_slots",
      description:
        "Check available appointment slots for a date range. Use this when a customer asks about availability or wants to book.",
      parameters: {
        type: "object",
        properties: {
          start_date: {
            type: "string",
            description: "Start date in YYYY-MM-DD format",
          },
          end_date: {
            type: "string",
            description: "End date in YYYY-MM-DD format (defaults to same as start_date if checking a single day)",
          },
        },
        required: ["start_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book an appointment for the customer at a specific date and time. Only call this after the customer confirms the slot.",
      parameters: {
        type: "object",
        properties: {
          date_time: {
            type: "string",
            description:
              "The appointment date and time in ISO format, e.g. 2026-03-08T14:00:00+08:00",
          },
          service: {
            type: "string",
            description: "The service being booked (e.g. Classic Lash Extensions)",
          },
        },
        required: ["date_time"],
      },
    },
  },
];

// Execute a tool call
async function executeTool(toolCall, contactId) {
  const name = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments);

  if (name === "check_available_slots") {
    const startDate = args.start_date;
    const endDate = args.end_date || args.start_date;
    const slots = await getAvailableSlots(startDate, endDate);
    return JSON.stringify(slots);
  }

  if (name === "book_appointment") {
    const result = await bookAppointment(
      contactId,
      args.date_time,
      args.service || "Appointment"
    );
    return JSON.stringify({
      success: true,
      appointmentId: result.id,
      message: "Appointment booked successfully",
    });
  }

  return JSON.stringify({ error: "Unknown tool" });
}

async function chat(contactId, message) {
  const [instructions, history] = await Promise.all([
    getSystemPrompt(),
    getHistory(contactId, 20),
  ]);

  const messages = [
    { role: "system", content: instructions },
    ...history,
    { role: "user", content: message },
  ];

  // First call — may return tool calls
  let response = await getClient().chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    tools,
    max_tokens: 1000,
  });

  let choice = response.choices[0];

  // Handle tool calls (up to 3 rounds)
  let rounds = 0;
  while (choice.finish_reason === "tool_calls" && rounds < 3) {
    rounds++;
    const toolCalls = choice.message.tool_calls;
    messages.push(choice.message);

    for (const tc of toolCalls) {
      console.log(`Tool call: ${tc.function.name}(${tc.function.arguments})`);
      const result = await executeTool(tc, contactId);
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

  // Save messages to DB
  await Promise.all([
    saveMessage(contactId, "user", message),
    saveMessage(contactId, "assistant", reply),
  ]);

  return reply;
}

module.exports = { chat };
