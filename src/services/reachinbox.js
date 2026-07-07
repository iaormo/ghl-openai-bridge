// Minimal ReachInbox API client — used to enrich a replying lead (LinkedIn, phone, company) when
// we create their GHL contact. Auth: REACHINBOX_API_KEY (ReachInbox → Settings → Integrations → API).
//
// The webhook payload only carries email + name; the full lead record (with the imported custom
// variables like `linkedin`) lives behind GET /leads/details?campaignId=&id= (or &email=).

const API = "https://api.reachinbox.ai/api/v1";

function apiKey() {
  return process.env.REACHINBOX_API_KEY || "";
}

function isConfigured() {
  return !!apiKey();
}

async function riGet(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${apiKey()}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`ReachInbox ${path} (${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Fetch a single lead's full record, including `attributes` (linkedin, phone, company, title, ...).
// Needs the campaign id plus the lead id OR email — both arrive in the webhook payload.
async function getLeadDetails({ campaignId, id, email }) {
  if (!isConfigured() || !campaignId || (!id && !email)) return null;
  const q = new URLSearchParams({ campaignId: String(campaignId) });
  if (id) q.set("id", String(id));
  else q.set("email", String(email));
  const data = await riGet(`/leads/details?${q.toString()}`);
  const lead = data.data || data;
  return lead && (lead.attributes || lead.email) ? lead : null;
}

// Pull the useful contact fields out of a lead's `attributes`, tolerant of case/spacing/underscore
// differences in the imported column names (e.g. "linkedin", "LinkedIn URL", "linkedin_url").
function extractContactFields(lead) {
  const attrs = (lead && lead.attributes) || {};
  const norm = (s) => String(s).toLowerCase().replace(/[\s_]+/g, "");
  const get = (...names) => {
    const wanted = names.map(norm);
    for (const k of Object.keys(attrs)) {
      if (wanted.includes(norm(k)) && attrs[k]) return String(attrs[k]).trim();
    }
    return "";
  };
  return {
    firstName: get("firstName", "first name"),
    lastName: get("lastName", "last name"),
    linkedin: get("linkedin", "linkedinurl", "linkedin url", "personal linkedin url", "linkedinprofile"),
    phone: get("phone", "phonenumber", "phone number", "mobile", "mobilephone"),
    companyName: get("companyName", "company", "company name", "organization", "organisation"),
    website: get("website", "companyurl", "website url", "companywebsite"),
    title: get("title", "jobtitle", "job title"),
  };
}

module.exports = { isConfigured, getLeadDetails, extractContactFields };
