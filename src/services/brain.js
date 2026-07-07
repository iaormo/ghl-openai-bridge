const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const BRAIN_PATH = path.join(ROOT, "brain.md");

// Knowledge appended to brain.md on EVERY reply. brain.md is the hub (persona, rules,
// playbooks); these carry the depth. Order matters — brain.md first, then these.
// (Redline and other per-client knowledge is NOT here — it loads on demand only for the
// relevant contact, via clients.js, so it never leaks into general replies or bloats them.)
const KNOWLEDGE_FILES = ["scaleplus.md", "scaleplus-crm.md"];

let brainCache = null;

// Read a repo-root file, returning "" (never throwing) if it's missing.
function readRoot(file) {
  try {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
  } catch (_) {
    return "";
  }
}

// The full always-on knowledge base = brain.md + the KNOWLEDGE_FILES, concatenated and cached.
// Injected into the system prompt on every message, so keep the parts accurate and non-contradictory.
function getBrain() {
  if (brainCache !== null) return brainCache;
  let out = readRoot("brain.md");
  if (!out) console.warn("Could not read brain.md (missing or empty)");
  const loaded = ["brain.md"];
  for (const f of KNOWLEDGE_FILES) {
    const content = readRoot(f);
    if (content) {
      out += `\n\n\n${content}`;
      loaded.push(f);
    }
  }
  brainCache = out;
  console.log(`Loaded brain (${brainCache.length} chars): ${loaded.join(" + ")}`);
  return brainCache;
}

// Clear the cache and re-read on next getBrain() call.
function reloadBrain() {
  brainCache = null;
  return getBrain();
}

// Load a specific knowledge file on demand (for per-client context, e.g. redline.md).
// Returns "" if the file doesn't exist.
function getKnowledgeFile(file) {
  return readRoot(String(file).trim());
}

module.exports = { getBrain, reloadBrain, getKnowledgeFile, BRAIN_PATH };
