// The Flows trial link goes out once per conversation. After that it is only repeated when the
// lead asks for it ("send the link again", "where do I sign up?"). brain.md says so too; this is
// the backstop, removing any sentence that carries the link a second time.
const TRIAL_LINK = "flows.scaleplus.io/register";
const ASKS_FOR_LINK = /\b(link|url|site|website|sign ?up|signup|register|saan|where|paano mag|how (do|can) i (start|join|try|sign)|send (it|again)|resend|ulit|again|lost|nawala)\b/i;

function dropRepeatedTrialLink(reply, history, message) {
  if (!reply || !reply.includes(TRIAL_LINK)) return reply;
  const sentBefore = (history || []).some((m) => m.role === "assistant" && String(m.content).includes(TRIAL_LINK));
  if (!sentBefore || ASKS_FOR_LINK.test(String(message || ""))) return reply;
  const kept = reply
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((part) => !part.includes(TRIAL_LINK))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return kept || reply;
}

module.exports = { dropRepeatedTrialLink, TRIAL_LINK };
