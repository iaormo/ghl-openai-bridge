const OpenAI = require("openai");
const { getHistory, saveMessage } = require("../db");

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
  return systemPrompt;
}

async function chat(contactId, message) {
  const [instructions, history] = await Promise.all([
    getSystemPrompt(),
    getHistory(contactId, 20),
  ]);

  // Build messages array: system prompt + history + new message
  const messages = [
    { role: "system", content: instructions },
    ...history,
    { role: "user", content: message },
  ];

  // Use Chat Completions (much faster than Assistants API)
  const response = await getClient().chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    max_tokens: 1000,
  });

  const reply = response.choices[0]?.message?.content;
  if (!reply) throw new Error("No reply from OpenAI");

  // Save both messages to DB for conversation history
  await Promise.all([
    saveMessage(contactId, "user", message),
    saveMessage(contactId, "assistant", reply),
  ]);

  return reply;
}

module.exports = { chat };
