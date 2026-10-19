// Flags messages that sound like someone in crisis so a human sees them, in addition to Skye's
// crisis reply (brain.md §14). Errs on the side of flagging: a false alarm costs Ian a glance.
const CRISIS = /\b(want(ed)? to die|wanna die|kill (my ?self|me)|suicid\w*|end (my|it all)|give up (on )?my ?self|give up now|no reason to live|hurt my ?self|self[- ]?harm|mamatay|magpakamatay|ayoko na mabuhay|gusto ko nang mawala|wala nang silbi buhay)\b/i;

function isCrisis(text) {
  return CRISIS.test(String(text || ""));
}

module.exports = { isCrisis };
