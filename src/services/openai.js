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

async function sendMessage(threadId, message) {
  await getClient().beta.threads.messages.create(threadId, {
    role: "user",
    content: message,
  });
}

async function runAssistant(threadId) {
  const run = await getClient().beta.threads.runs.createAndPoll(threadId, {
    assistant_id: process.env.OPENAI_ASSISTANT_ID,
  });

  if (run.status !== "completed") {
    throw new Error(`Assistant run failed with status: ${run.status}`);
  }

  return run.id;
}

async function getLatestReply(threadId, runId) {
  const messages = await getClient().beta.threads.messages.list(threadId, {
    run_id: runId,
    limit: 1,
  });

  const reply = messages.data[0];
  if (!reply || reply.role !== "assistant") {
    throw new Error("No assistant reply found");
  }

  return reply.content
    .filter((block) => block.type === "text")
    .map((block) => block.text.value)
    .join("\n");
}

async function chat(contactId, message) {
  const threadId = await getOrCreateThread(contactId);
  await sendMessage(threadId, message);
  const runId = await runAssistant(threadId);
  return getLatestReply(threadId, runId);
}

module.exports = { chat };
