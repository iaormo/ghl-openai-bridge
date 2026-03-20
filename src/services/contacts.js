const GHL_API_BASE = "https://services.leadconnectorhq.com";
const LOCATION_ID = process.env.GHL_LOCATION_ID || "JYNTUGxvUZVoROmjpf50";

function headers(version = "2021-07-28") {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    "Content-Type": "application/json",
    Version: version,
  };
}

// Cache for location custom field definitions (id → key/name mapping)
let fieldDefCache = null;
let fieldDefCacheTime = 0;
const FIELD_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getFieldDefinitions() {
  const now = Date.now();
  if (fieldDefCache && now - fieldDefCacheTime < FIELD_CACHE_TTL) {
    return fieldDefCache;
  }
  try {
    const fields = await getLocationCustomFields();
    const map = {};
    for (const f of fields) {
      map[f.id] = {
        key: f.fieldKey || f.name,
        name: f.name,
        dataType: f.dataType,
      };
    }
    fieldDefCache = map;
    fieldDefCacheTime = now;
    return map;
  } catch (err) {
    console.warn("Could not fetch field definitions for resolution:", err.message);
    return fieldDefCache || {};
  }
}

// Get contact information by ID
async function getContactInfo(contactId) {
  const response = await fetch(
    `${GHL_API_BASE}/contacts/${contactId}`,
    { headers: headers() }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to get contact: ${err}`);
  }

  const data = await response.json();
  const c = data.contact || data;

  // Resolve custom field IDs to readable key names
  const rawFields = c.customFields || [];
  const fieldDefs = await getFieldDefinitions();
  const resolvedFields = rawFields.map((f) => {
    const def = fieldDefs[f.id];
    return {
      id: f.id,
      key: def ? def.key : f.id,
      name: def ? def.name : f.id,
      value: f.value,
    };
  });

  return {
    id: c.id,
    firstName: c.firstName || c.firstNameRaw || "",
    lastName: c.lastName || c.lastNameRaw || "",
    fullName: c.contactName || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
    email: c.email || "",
    phone: c.phone || "",
    tags: c.tags || [],
    customFields: resolvedFields,
  };
}

// Update contact name and/or phone
async function updateContactInfo(contactId, { firstName, lastName, phone, email, name }) {
  const body = {};

  if (name) {
    const parts = name.trim().split(/\s+/);
    body.firstName = parts[0];
    body.lastName = parts.slice(1).join(" ") || "";
  }
  if (firstName) body.firstName = firstName;
  if (lastName) body.lastName = lastName;
  if (phone) body.phone = phone.replace(/[\s-]/g, "");
  if (email) body.email = email;

  const response = await fetch(
    `${GHL_API_BASE}/contacts/${contactId}`,
    {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to update contact: ${err}`);
  }

  const data = await response.json();
  return { success: true, contact: data.contact || data };
}

// Update a custom field on a contact
async function updateCustomField(contactId, key, value) {
  // First, get existing custom fields to find the field ID
  const contact = await getContactInfo(contactId);
  const existingFields = contact.customFields || [];

  // Try to find the field by key name
  const existing = existingFields.find(
    (f) => f.key === key || f.fieldKey === key || f.id === key
  );

  const customFields = existing
    ? [{ id: existing.id, value }]
    : [{ key, field_value: value }];

  const response = await fetch(
    `${GHL_API_BASE}/contacts/${contactId}`,
    {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ customFields }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to update custom field: ${err}`);
  }

  return { success: true, key, value };
}

// Create a custom field in the GHL location
async function createLocationCustomField(name, dataType = "TEXT") {
  const response = await fetch(
    `${GHL_API_BASE}/locations/${LOCATION_ID}/customFields`,
    {
      method: "POST",
      headers: headers("2021-07-28"),
      body: JSON.stringify({
        name,
        dataType,
        position: 0,
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to create custom field in GHL: ${err}`);
  }

  const data = await response.json();
  return data.customField || data;
}

// List all custom fields in the GHL location
async function getLocationCustomFields() {
  const response = await fetch(
    `${GHL_API_BASE}/locations/${LOCATION_ID}/customFields`,
    { headers: headers("2021-07-28") }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to list custom fields: ${err}`);
  }

  const data = await response.json();
  return data.customFields || [];
}

module.exports = { getContactInfo, updateContactInfo, updateCustomField, createLocationCustomField, getLocationCustomFields };
