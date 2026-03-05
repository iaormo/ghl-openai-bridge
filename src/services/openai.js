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

// Cancel any active runs on a thread before starting a new one
async function cancelActiveRuns(threadId) {
  try {
    const runs = await getClient().beta.threads.runs.list(threadId, { limit: 5 });
    for (const run of runs.data) {
      if (["in_progress", "queued", "requires_action"].includes(run.status)) {
        await getClient().beta.threads.runs.cancel(threadId, run.id);
        // Wait briefly for cancellation
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (err) {
    console.warn("Error cancelling active runs:", err.message);
  }
}

async function chat(contactId, message) {
  const threadId = await getOrCreateThread(contactId);

  // Cancel any lingering runs to avoid "already has an active run" error
  await cancelActiveRuns(threadId);

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
