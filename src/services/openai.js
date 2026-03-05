const OpenAI = require("openai");
const { getThread, saveThread } = require("../db");

let openai = null;

function getClient() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

async function getOrCreateThread(contactId) {
  const existingThreadId = await getThread(contactId);
  if (existingThreadId) return existingThreadId;

  const thread = await getClient().beta.threads.create();
  await saveThread(contactId, thread.id);
  return thread.id;
}

async function chat(contactId, message) {
  const threadId = await getOrCreateThread(contactId);

  // Add message and run assistant in one call using stream for faster response
  const stream = await getClient().beta.threads.runs.stream(threadId, {
    assistant_id: process.env.OPENAI_ASSISTANT_ID,
    additional_messages: [{ role: "user", content: message }],
  });

  // Collect the full text from the stream
  let reply = "";
  for await (const event of stream) {
    if (
      event.event === "thread.message.delta" &&
      event.data?.delta?.content
    ) {
      for (const block of event.data.delta.content) {
        if (block.type === "text") {
          reply += block.text.value;
        }
      }
    }
  }

  if (!reply) {
    throw new Error("No assistant reply received");
  }

  return reply;
}

module.exports = { chat };
