const OpenAI = require("openai");
const { getHistory, saveMessage } = require("../db");
const {
  getAvailableSlots,
  isSlotAvailable,
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
  createContactNote,
  getContactNotes,
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
      name: "addContactNote",
      description: "Log an important detail or context about the lead to their CRM record as a note. Call this whenever the lead shares something meaningful — their business, what they do, goals, needs, situation, or a decision — even casually (e.g. 'I have a potato business', 'we're opening a 2nd branch', 'main goal is more repeat customers'). Also save structured facts with updateCustomField. Keep the note short and factual. Don't let good context vanish into the chat.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "The concise detail/context to log on the contact's record" },
        },
        required: ["note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getAvailableSlots",
      description: "Check open times for the FREE AUTOMATION AUDIT call on a date. Returns { totalAvailable, options } per date — 'options' is a short curated list of {iso, display} times to offer. Present just 2-3 of them conversationally (e.g. morning vs afternoon); do NOT list them all. Only use this when booking the automation audit call.",
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
      description: "Book the FREE AUTOMATION AUDIT call (aka discovery/strategy call) for the lead. ONLY use this for the automation audit call — never for CRM signups (send CRM-interested leads to scaleplus.io/crm instead) or any other purpose. HARD REQUIREMENT: you must have the lead's name, PHONE, and EMAIL before calling this — the booking will be REFUSED without email and phone (they're needed for confirmations and reminders). Only call AFTER the lead has picked a specific slot you offered, and pass the exact `iso` value from getAvailableSlots as date_time.",
      parameters: {
        type: "object",
        properties: {
          date_time: { type: "string", description: "The exact `iso` value of the chosen slot from getAvailableSlots (e.g. 2026-03-08T14:00:00+08:00). Must be a real available slot." },
          service: { type: "string", description: "The topic/reason of the audit call (e.g. 'Automation Audit — after-hours FB inquiries for dental clinic')" },
          customer_name: { type: "string", description: "Lead's name for the appointment title" },
          phone: { type: "string", description: "Lead's phone number (REQUIRED — ask for it before booking)" },
          email: { type: "string", description: "Lead's email address (REQUIRED — ask for it before booking; used for the confirmation)" },
          booking_notes: { type: "string", description: "REQUIRED: the reason for the booking plus a brief summary of everything relevant from this chat — their business, industry, team size, current tools, pain points, and what they want. This is saved to the CRM for the team running the call." },
        },
        required: ["date_time", "service", "customer_name", "phone", "email", "booking_notes"],
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

      case "addContactNote": {
        await createContactNote(contactId, `📝 ${args.note}`);
        return JSON.stringify({ success: true });
      }

      case "getAvailableSlots": {
        const endDate = args.end_date || args.start_date;
        const slots = await getAvailableSlots(args.start_date, endDate);
        return JSON.stringify(slots);
      }

      case "appointmentBooking": {
        // HARD REQUIREMENT: email + phone must be known (from args or the contact record)
        // before any booking goes through.
        let contact = null;
        try { contact = await getContactInfo(contactId); } catch (_) {}
        const email = args.email || (contact && contact.email) || "";
        const phone = args.phone || (contact && contact.phone) || "";
        if (!email || !phone) {
          const missing = [!email && "email", !phone && "phone number"].filter(Boolean).join(" and ");
          return JSON.stringify({
            error: `BOOKING_REFUSED: missing the lead's ${missing}. Ask for it naturally (it's needed for the confirmation and reminders), then call appointmentBooking again. NEVER book without email and phone.`,
          });
        }

        // Sync the details onto the contact record so GHL confirmations/reminders work
        try {
          await updateContactInfo(contactId, {
            name: args.customer_name,
            phone: args.phone,
            email: args.email,
          });
        } catch (err) {
          console.warn("Pre-booking contact sync failed (continuing):", err.message);
        }

        // DUPLICATE GUARD: if this contact already has an upcoming audit call, never create a
        // second one — and never tell them a slot is "unavailable" when it's their OWN booking.
        let existingAppts = [];
        try { existingAppts = await getContactAppointments(contactId); } catch (_) {}
        if (existingAppts.length) {
          const target = new Date(args.date_time).getTime();
          const same = existingAppts.find((a) => {
            const raw = a.startTimeRaw || "";
            const t = raw.includes("+") || raw.includes("Z") ? new Date(raw).getTime() : new Date(raw + "+08:00").getTime();
            return Math.abs(t - target) < 60000;
          });
          if (same) {
            return JSON.stringify({
              already_booked: true,
              appointmentId: same.id,
              booked_for: `${same.date} ${same.time} (Philippine Time)`,
              note: "This lead ALREADY has this exact call booked. Warmly confirm the existing booking — do NOT create a duplicate and do NOT say the slot is unavailable.",
            });
          }
          return JSON.stringify({
            has_existing_booking: true,
            existing: existingAppts.map((a) => `${a.date} ${a.time} — "${a.title}" (id: ${a.id})`),
            note: "This lead already has an upcoming audit call. Do NOT book another. If they want a different time, use rescheduleAppointment on the existing appointment; otherwise just confirm the existing one.",
          });
        }

        // CODE-ENFORCED slot validation: the model cannot book (or confirm) a time that isn't
        // an actual open slot. If the pick is invalid, refuse and hand back the REAL open times.
        const check = await isSlotAvailable(args.date_time);
        if (!check.available) {
          const opts = check.options && check.options.length
            ? `The actual open times on that day are: ${check.options.join(", ")}. Offer the lead one of THESE (never a made-up time), get their pick, then book that exact slot.`
            : `There are no open slots that day — check another day with getAvailableSlots.`;
          return JSON.stringify({
            error: `SLOT_NOT_AVAILABLE: ${args.date_time} is NOT an open slot. Do NOT tell the lead it's booked. ${opts}`,
          });
        }

        const name = args.customer_name || (contact && contact.fullName) || "Lead";
        const title = `${name} x ScalePlus - ${args.service}`;
        const notes = args.booking_notes || args.service;

        // Human-readable booked time (used in the confirmation AND the note)
        const bookedFor = new Date(args.date_time).toLocaleString("en-PH", {
          timeZone: TIMEZONE,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

        // Re-fetch the contact so the note captures the latest qualification fields saved
        // earlier in this same conversation.
        let freshContact = contact;
        try { freshContact = await getContactInfo(contactId); } catch (_) {}

        const result = await bookAppointment(contactId, args.date_time, title, notes);

        // Log a COMPLETE booking note on the contact: booking details + full lead profile
        // (every saved custom field) + the chat summary — so the team is fully briefed.
        try {
          const FIELD_LABELS = {
            business_name: "Business",
            industry: "Industry",
            team_size: "Team size",
            current_tools: "Current tools",
            pain_points: "Pain points",
            service_interest: "Interested in",
            budget_timeline: "Budget / timeline",
            lead_status: "Lead status",
          };
          const savedFields = ((freshContact && freshContact.customFields) || []).filter(
            (f) => f.value != null && String(f.value).trim() !== ""
          );
          const profile = savedFields
            .filter((f) => FIELD_LABELS[f.key])
            .map((f) => `• ${FIELD_LABELS[f.key]}: ${f.value}`)
            .join("\n");
          const tags = (freshContact && freshContact.tags && freshContact.tags.length)
            ? `\nTags: ${freshContact.tags.join(", ")}`
            : "";

          const noteBody =
            `📅 AUTOMATION AUDIT BOOKED\n` +
            `When: ${bookedFor} (Philippine Time)\n` +
            `Reason / topic: ${args.service}\n` +
            `Appointment ID: ${result.id || result.appointmentId || "(n/a)"}\n\n` +
            `CONTACT\n• Name: ${name}\n• Phone: ${phone}\n• Email: ${email}${tags}\n\n` +
            `LEAD PROFILE\n${profile || "• (none captured yet)"}\n\n` +
            `REASON FOR BOOKING / CHAT SUMMARY\n${notes}`;

          await createContactNote(contactId, noteBody);
        } catch (err) {
          console.warn("Booking note creation failed (non-fatal):", err.message);
        }
        return JSON.stringify({
          success: true,
          appointmentId: result.id || result.appointmentId,
          booked_for: `${bookedFor} (Philippine Time) — confirm THIS exact date/time to the lead`,
          ...result,
        });
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

// Prefetch the contact's info + upcoming appointments and render a compact context block for
// the system prompt. This removes the getContactInformation/getContactAppointments tool
// round-trips at conversation start (each one costs a full extra OpenAI call, ~1-2s).
// Guarded by a timeout so a slow GHL API never delays the reply — on timeout/error the block
// is simply omitted and the model can still use the tools.
const CONTEXT_PREFETCH_TIMEOUT_MS = 2500;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("prefetch timeout")), ms)),
  ]);
}

async function buildContactContext(contactId) {
  if (!contactId || !process.env.GHL_API_KEY) return "";
  const [info, appts] = await Promise.all([
    withTimeout(getContactInfo(contactId), CONTEXT_PREFETCH_TIMEOUT_MS).catch(() => null),
    withTimeout(getContactAppointments(contactId), CONTEXT_PREFETCH_TIMEOUT_MS).catch(() => null),
  ]);
  if (!info && !appts) return "";

  const lines = ["\n\nCONTACT CONTEXT (preloaded from the CRM — trust this; do NOT call getContactInformation or getContactAppointments unless you need fresher data than shown here):"];
  if (info) {
    lines.push(`Name: ${info.fullName || "(unknown)"} | Phone: ${info.phone || "(none)"} | Email: ${info.email || "(none)"}`);
    if (info.tags && info.tags.length) lines.push(`Tags: ${info.tags.join(", ")}`);
    const saved = (info.customFields || []).filter((f) => f.value != null && f.value !== "");
    if (saved.length) {
      lines.push("Saved fields: " + saved.map((f) => `${f.key}=${f.value}`).join("; "));
    }
    lines.push(
      (info.fullName || saved.length)
        ? "This is a RETURNING contact — greet them by name and pick up where they left off."
        : "No saved details — likely a NEW contact."
    );
  }
  if (appts) {
    lines.push(
      appts.length
        ? "Upcoming appointments: " + appts.map((a) => `${a.date} ${a.time} — "${a.title}" (id: ${a.id})`).join(" | ")
        : "Upcoming appointments: none."
    );
  }
  return lines.join("\n");
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

// Note appended to the prompt so replies fit the channel they're going to.
function channelNote(channel) {
  if (channel === "Email") {
    return "\n\nCHANNEL: You are replying by EMAIL. Write it like a short, warm email — open with a greeting (use their first name if you know it), a few clear sentences, and a friendly sign-off on its own line: \"— Ian, ScalePlus\". You can be slightly more complete than a chat message, but stay concise. Plain text, no markdown.";
  }
  return "\n\nCHANNEL: You are on live chat/messaging — keep it short and conversational, no email-style greeting or sign-off.";
}

// Production chat — used by the GHL webhook. Uses the OpenAI Responses API.
async function chat(contactId, message, channel = "chat") {
  const [history, contactContext] = await Promise.all([
    getHistory(contactId, 20),
    buildContactContext(contactId),
  ]);
  const instructions = buildInstructions() + contactContext + channelNote(channel);
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

// Compose a FIRST-TOUCH outbound email for a lead who just filled out a form. Reads their
// notes + saved fields, writes a warm personalized email that engages and drives to booking.
async function composeOutreach(contactId, formContext = "") {
  const [contactContext, notes] = await Promise.all([
    buildContactContext(contactId),
    getContactNotes(contactId).catch(() => []),
  ]);
  const notesText = notes.length ? notes.slice(0, 8).join("\n---\n") : "(no notes on file)";

  const directive =
    "\n\n=== OUTBOUND FIRST-TOUCH TASK ===\n" +
    "A NEW LEAD just filled out the contact form on scaleplus.io. This is your FIRST email to " +
    "them — they have NOT messaged you, so don't write as if continuing a chat. Write a genuine, " +
    "personalized outreach EMAIL.\n\n" +
    "WHAT THEY SUBMITTED / NOTES ON FILE:\n" + notesText + "\n" +
    (formContext ? "\nFORM DETAILS:\n" + formContext + "\n" : "") +
    "\nThe email must:\n" +
    "- Open warmly with their first name if known.\n" +
    "- Show you actually read what they shared — reference a specific detail (their business, " +
    "goal, or need). Never generic.\n" +
    "- Ask 1-2 genuine questions to understand their situation.\n" +
    "- End with a clear, low-pressure CTA to book the free automation audit call (offer to find a time).\n" +
    "- Sound like a real person wrote it — short, warm, no markdown, sign off '— Ian, ScalePlus'.\n" +
    "FORMAT: first line exactly 'Subject: <short compelling subject>', then a blank line, then the email body.\n" +
    "Also, if the notes contain business details not yet saved as fields, save them with updateCustomField.";

  const instructions = buildInstructions() + contactContext + channelNote("Email") + directive;
  const input = [{ role: "user", content: "Write the outreach email now." }];
  const model = getModel();
  const toolDefs = responsesTools(tools);

  let response = await getClient().responses.create({
    model, instructions, input, tools: toolDefs, max_output_tokens: 700, store: false,
  });
  let rounds = 0;
  while (rounds < 5) {
    const calls = (response.output || []).filter((o) => o.type === "function_call");
    if (!calls.length) break;
    rounds++;
    input.push(...response.output);
    for (const call of calls) {
      const result = await runTool(call.name, call.arguments, contactId);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
    response = await getClient().responses.create({
      model, instructions, input, tools: toolDefs, max_output_tokens: 700, store: false,
    });
  }

  const reply = response.output_text;
  if (reply) await saveMessage(contactId, "assistant", reply); // so the thread has context if they reply
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

  const [history, contactContext] = await Promise.all([
    getHistory(contactId, 20),
    buildContactContext(contactId),
  ]);
  const instructions = buildInstructions(systemPromptOverride ?? null) + contactContext;
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
  composeOutreach,
  playgroundChat,
  getClient,
  setApiKey,
  getModel,
  setModel,
  tools,
  runTool,
  getManilaDateContext,
};
