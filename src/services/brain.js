const fs = require("fs");
const path = require("path");

const BRAIN_PATH = path.join(__dirname, "..", "..", "brain.md");

let brainCache = null;

// Read brain.md from disk (cached). This is the bot's knowledge base — injected
// into the system prompt on every request. Returns "" (with a warning) if missing
// so the server never crashes on boot.
function getBrain() {
  if (brainCache !== null) return brainCache;
  try {
    brainCache = fs.readFileSync(BRAIN_PATH, "utf8");
    console.log(`Loaded brain.md (${brainCache.length} chars, cached)`);
  } catch (err) {
    console.warn("Could not read brain.md:", err.message);
    brainCache = "";
  }
  return brainCache;
}

// Clear the cache and re-read on next getBrain() call.
function reloadBrain() {
  brainCache = null;
  return getBrain();
}

module.exports = { getBrain, reloadBrain, BRAIN_PATH };
