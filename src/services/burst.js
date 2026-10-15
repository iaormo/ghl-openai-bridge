// One reply per burst.
//
// Leads often send the same question several times, or tap a Messenger quick question over and
// over, or split one thought across three quick messages. Answering each one separately floods
// them with near-identical replies. Instead, messages from the same contact are collected while
// they keep typing and answered together once they pause:
//
//   - each new message restarts a short quiet timer (BURST_WAIT_MS, default 6s);
//   - a burst never waits longer than BURST_MAX_WAIT_MS (default 20s) from its first message;
//   - repeats inside the burst are dropped, so "price?" x5 is one question;
//   - only one reply is ever being written per contact; messages arriving meanwhile wait for it;
//   - a burst that only repeats what was just answered (within REPEAT_WINDOW_MS) gets no reply.
//
// In memory, per process: fine for the single Railway instance this runs on.

const WAIT_MS = Number(process.env.BURST_WAIT_MS || 6000);
const MAX_WAIT_MS = Number(process.env.BURST_MAX_WAIT_MS || 20000);
const REPEAT_WINDOW_MS = Number(process.env.BURST_REPEAT_WINDOW_MS || 3 * 60_000);

const pending = new Map(); // contactId -> { messages: [], timer, firstAt, handler }
const busy = new Map(); // contactId -> Promise of the reply in flight
const answered = new Map(); // contactId -> { keys: Set, at }

// "Magkano?? " and "magkano" are the same question.
function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function uniqueMessages(messages) {
  const seen = new Set();
  const out = [];
  for (const m of messages) {
    const k = normalize(m);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(m.trim());
  }
  return out;
}

// Several different messages in one burst (e.g. three quick-question taps) must all get answered,
// not just the first, so the model is told plainly to cover each one.
function combine(messages) {
  if (messages.length === 1) return messages[0];
  return "(They sent these messages in a row. Answer EVERY one of them, briefly, in a single reply.)\n" +
    messages.map((m) => "- " + m).join("\n");
}

/**
 * Queue a message. `handler(combinedText, messages)` runs once per burst and must send the reply.
 * The latest handler wins, so the newest channel/location details are the ones used.
 */
function enqueue(contactId, text, handler) {
  let b = pending.get(contactId);
  if (!b) {
    b = { messages: [], timer: null, firstAt: Date.now(), handler };
    pending.set(contactId, b);
  }
  b.messages.push(String(text));
  b.handler = handler;

  clearTimeout(b.timer);
  const wait = Math.max(0, Math.min(WAIT_MS, b.firstAt + MAX_WAIT_MS - Date.now()));
  b.timer = setTimeout(() => flush(contactId), wait);
  if (b.timer.unref) b.timer.unref();
}

async function flush(contactId) {
  // Wait for a reply already being written, then take everything that arrived meanwhile.
  const inFlight = busy.get(contactId);
  if (inFlight) {
    await inFlight.catch(() => {});
    if (busy.get(contactId) && busy.get(contactId) !== inFlight) return; // another flush took it
  }
  const b = pending.get(contactId);
  if (!b) return;
  pending.delete(contactId);
  clearTimeout(b.timer);

  const messages = uniqueMessages(b.messages);
  if (!messages.length) return;

  // Nothing new since the last reply: they're just tapping the same button again.
  const prev = answered.get(contactId);
  if (prev && Date.now() - prev.at < REPEAT_WINDOW_MS && messages.every((m) => prev.keys.has(normalize(m)))) {
    console.log(`Burst: skipped repeat from ${contactId} (${b.messages.length} msg) — already answered`);
    return;
  }

  if (b.messages.length > 1) {
    console.log(`Burst: ${b.messages.length} messages from ${contactId} → 1 reply (${messages.length} unique)`);
  }

  const run = (async () => {
    try {
      await b.handler(combine(messages), messages);
      answered.set(contactId, { keys: new Set(messages.map(normalize)), at: Date.now() });
    } catch (e) {
      console.error(`Burst reply failed for ${contactId}:`, e.message);
    }
  })();
  busy.set(contactId, run);
  await run;
  if (busy.get(contactId) === run) busy.delete(contactId);

  for (const [k, v] of answered) if (Date.now() - v.at > REPEAT_WINDOW_MS) answered.delete(k);
}

module.exports = { enqueue, combine, normalize, uniqueMessages, _state: { pending, busy, answered } };
