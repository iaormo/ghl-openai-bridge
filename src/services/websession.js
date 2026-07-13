// In-memory session store for ANONYMOUS website chat visitors.
//
// The website chat opens with a synthetic contactId ("scaleplus-web-<sessionId>") that does NOT
// exist in GHL. Every GHL write the bot attempts against it — qualification custom fields, notes,
// and ultimately the appointment booking — used to 400 with "Contact not found", so the bot could
// neither qualify nor book for web visitors (it only worked for GHL-webhook leads that already have
// a real contact id).
//
// Fix: buffer everything the bot captures against the web session, and the moment the visitor shares
// an email or phone, create ONE real GHL contact (upsert — dedupes by email/phone), flush the buffer
// onto it, and route all further operations to the real id. This keeps the CRM clean (no empty
// contact per page-load — a contact is only created once we have a real identifier) while making
// qualifying + booking actually persist.
//
// The store is in-memory (resets on redeploy). Chat history still lives in Postgres keyed by the
// synthetic id, so conversation continuity survives restarts; and because contact creation uses GHL
// upsert, a returning visitor after a redeploy merges into the same GHL contact by email rather than
// duplicating.

const {
  upsertContactByEmail,
  upsertContactByPhone,
  updateContactInfo,
  updateCustomField,
  createContactNote,
} = require("./contacts");

const WEB_PREFIX = "scaleplus-web-";
const sessions = new Map(); // webId -> { ghlId, profile:{name,email,phone}, fields:{key:val}, notes:[], creating }

function isWebSession(id) {
  return typeof id === "string" && id.startsWith(WEB_PREFIX);
}

function getSession(webId) {
  let s = sessions.get(webId);
  if (!s) {
    s = { ghlId: null, profile: {}, fields: {}, notes: [], creating: null };
    sessions.set(webId, s);
  }
  return s;
}

// Return the resolved real GHL id for a web session, or null if none created yet.
function resolve(webId) {
  const s = sessions.get(webId);
  return s ? s.ghlId : null;
}

// Flush everything buffered while anonymous onto the freshly-created GHL contact. Best-effort per
// item — one failed field never blocks the rest (or the booking).
async function flushBuffer(session) {
  const id = session.ghlId;
  if (!id) return;
  if (Object.keys(session.profile).length) {
    try { await updateContactInfo(id, session.profile); }
    catch (e) { console.warn("web session profile flush failed:", e.message); }
  }
  for (const [key, value] of Object.entries(session.fields)) {
    try { await updateCustomField(id, key, value); }
    catch (e) { console.warn(`web session field '${key}' flush failed:`, e.message); }
  }
  for (const note of session.notes) {
    try { await createContactNote(id, note); }
    catch (e) { console.warn("web session note flush failed:", e.message); }
  }
  session.fields = {};
  session.notes = [];
}

// Ensure a real GHL contact exists for this web session. Merges any name/email/phone we just learned
// into the buffered profile; once we have an email OR phone, creates (upserts) the contact, flushes
// the buffer, and returns the real id. Returns null while we still have no identifier to create with.
async function ensureGhlContact(webId, incoming = {}) {
  const s = getSession(webId);
  if (incoming.name) s.profile.name = incoming.name;
  if (incoming.email) s.profile.email = incoming.email;
  if (incoming.phone) s.profile.phone = incoming.phone;

  if (s.ghlId) {
    // Already real — apply any newly-learned identity fields directly.
    if (incoming.name || incoming.email || incoming.phone) {
      try { await updateContactInfo(s.ghlId, incoming); }
      catch (e) { console.warn("web session identity update failed:", e.message); }
    }
    return s.ghlId;
  }

  const { email, phone } = s.profile;
  if (!email && !phone) return null;

  if (!s.creating) {
    s.creating = (async () => {
      const id = email
        ? await upsertContactByEmail(email, s.profile.name, { phone })
        : await upsertContactByPhone(phone);
      s.ghlId = id;
      await flushBuffer(s);
      return id;
    })();
    // Reset on failure so a later turn can retry contact creation.
    s.creating.catch(() => { s.creating = null; });
  }
  return s.creating;
}

// Buffer a qualification custom field while still anonymous.
function bufferField(webId, key, value) {
  getSession(webId).fields[key] = value;
}

// Buffer a note while still anonymous.
function bufferNote(webId, note) {
  getSession(webId).notes.push(note);
}

// Render the buffered profile as a getContactInfo-shaped object, so getContactInformation returns
// what we've captured this session instead of erroring while anonymous.
function bufferedContact(webId) {
  const s = getSession(webId);
  return {
    id: null,
    firstName: "",
    lastName: "",
    fullName: s.profile.name || "",
    email: s.profile.email || "",
    phone: s.profile.phone || "",
    tags: [],
    customFields: Object.entries(s.fields).map(([key, value]) => ({ key, value })),
  };
}

module.exports = {
  isWebSession,
  getSession,
  resolve,
  ensureGhlContact,
  bufferField,
  bufferNote,
  bufferedContact,
  WEB_PREFIX,
};
