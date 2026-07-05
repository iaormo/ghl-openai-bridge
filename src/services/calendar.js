const GHL_API_BASE = "https://services.leadconnectorhq.com";
const CALENDAR_ID = process.env.GHL_CALENDAR_ID || "hpj5HNU9F20BClTjiVTY";
const LOCATION_ID = process.env.GHL_LOCATION_ID || "GfDBeSbJmjBtcqGK6vXN";
const TIMEZONE = process.env.GHL_TIMEZONE || "Asia/Manila";

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    "Content-Type": "application/json",
    Version: "2021-04-15",
  };
}

// Parse YYYY-MM-DD as local midnight timestamp (not UTC)
function dateToTimestamp(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

// Format a date string for display in Manila time
function formatDisplay(dateStr) {
  // GHL returns "2026-03-06 14:00:00" (no timezone) — treat as Manila time
  const d = dateStr.includes("+") || dateStr.includes("Z")
    ? new Date(dateStr)
    : new Date(dateStr + "+08:00");
  return {
    date: d.toLocaleDateString("en-PH", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: TIMEZONE,
    }),
    time: d.toLocaleTimeString("en-PH", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: TIMEZONE,
    }),
  };
}

// Get available slots for a date range
async function getAvailableSlots(startDate, endDate) {
  const start = dateToTimestamp(startDate);
  const endPlusOne = dateToTimestamp(endDate) + 86400000;

  const url = `${GHL_API_BASE}/calendars/${CALENDAR_ID}/free-slots?startDate=${start}&endDate=${endPlusOne}&timezone=${TIMEZONE}`;
  const response = await fetch(url, { headers: headers() });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to get slots: ${err}`);
  }

  const data = await response.json();
  const result = {};
  for (const [date, info] of Object.entries(data)) {
    if (date === "traceId") continue;
    const all = (info.slots || []).map((slot) => {
      const d = new Date(slot);
      return {
        iso: slot,
        display: d.toLocaleTimeString("en-PH", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: TIMEZONE,
        }),
      };
    });
    // Offer just 3 evenly-spread options (morning / midday / afternoon-evening) so the bot
    // suggests a few clean choices instead of dumping 30+ times. Full count kept for context.
    const MAX = 3;
    let picked = all;
    if (all.length > MAX) {
      const step = (all.length - 1) / (MAX - 1);
      picked = Array.from({ length: MAX }, (_, i) => all[Math.round(i * step)]);
    }
    result[date] = { totalAvailable: all.length, options: picked };
  }
  return result;
}

// Validate that an exact time is a real, currently-open slot (uses the FULL uncapped slot list
// for the slot's date). Returns { available, options } — options is the full list of open
// display times for that day, so the caller can re-offer real times if the pick is invalid.
async function isSlotAvailable(isoDateTime) {
  try {
    const date = String(isoDateTime).slice(0, 10); // YYYY-MM-DD (iso carries +08:00)
    const start = dateToTimestamp(date);
    const endPlusOne = start + 86400000;
    const url = `${GHL_API_BASE}/calendars/${CALENDAR_ID}/free-slots?startDate=${start}&endDate=${endPlusOne}&timezone=${TIMEZONE}`;
    const response = await fetch(url, { headers: headers() });
    if (!response.ok) return { available: false, options: [], error: await response.text() };
    const data = await response.json();
    const slots = [];
    for (const [d, info] of Object.entries(data)) {
      if (d === "traceId") continue;
      (info.slots || []).forEach((s) => slots.push(s));
    }
    const target = new Date(isoDateTime).getTime();
    const available = slots.some((s) => new Date(s).getTime() === target);
    const options = slots.map((s) =>
      new Date(s).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIMEZONE })
    );
    return { available, options };
  } catch (err) {
    return { available: false, options: [], error: err.message };
  }
}

// Book an appointment
async function bookAppointment(contactId, slotDateTime, title, notes) {
  // Keep the timezone offset if provided, otherwise assume Manila
  const startTime = slotDateTime.includes("+") || slotDateTime.includes("Z")
    ? slotDateTime
    : slotDateTime + "+08:00";

  const body = {
    calendarId: CALENDAR_ID,
    locationId: LOCATION_ID,
    contactId,
    startTime,
    title: title || "Appointment",
    appointmentStatus: "new",
  };
  if (notes) body.notes = notes;

  const response = await fetch(
    `${GHL_API_BASE}/calendars/events/appointments`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to book: ${err}`);
  }

  return response.json();
}

// Get appointments for a contact
async function getContactAppointments(contactId) {
  const response = await fetch(
    `${GHL_API_BASE}/contacts/${contactId}/appointments`,
    { headers: headers() }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to get appointments: ${err}`);
  }

  const data = await response.json();

  // GHL returns startTime as "2026-03-06 14:00:00" without timezone
  // Treat as Manila time for comparison
  const nowManila = new Date().toLocaleString("en-US", { timeZone: TIMEZONE });
  const now = new Date(nowManila);

  return (data.events || [])
    .filter((a) => {
      const raw = a.startTime || a.start;
      // Parse as Manila time
      const apptDate = raw.includes("+") || raw.includes("Z")
        ? new Date(raw)
        : new Date(raw + "+08:00");
      return apptDate > now && a.appointmentStatus !== "cancelled";
    })
    .map((a) => {
      const raw = a.startTime || a.start;
      const display = formatDisplay(raw);
      return {
        id: a.id,
        title: a.title,
        date: display.date,
        time: display.time,
        startTimeRaw: raw,
        status: a.appointmentStatus || a.status,
      };
    });
}

// Reschedule an appointment
async function rescheduleAppointment(appointmentId, newDateTime) {
  // Send with Manila timezone offset
  const startTime = newDateTime.includes("+") || newDateTime.includes("Z")
    ? newDateTime
    : newDateTime + "+08:00";

  const response = await fetch(
    `${GHL_API_BASE}/calendars/events/appointments/${appointmentId}`,
    {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ startTime }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to reschedule: ${err}`);
  }

  const result = await response.json();
  return {
    success: true,
    appointmentId: result.id,
    newTime: startTime,
  };
}

// Cancel an appointment
async function cancelAppointment(appointmentId) {
  const response = await fetch(
    `${GHL_API_BASE}/calendars/events/appointments/${appointmentId}`,
    {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ appointmentStatus: "cancelled" }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to cancel: ${err}`);
  }

  return { success: true, appointmentId };
}

// Fetch all calendars from the GHL location
async function getLocationCalendars() {
  const response = await fetch(
    `${GHL_API_BASE}/calendars/?locationId=${LOCATION_ID}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to fetch calendars: ${err}`);
  }

  const data = await response.json();
  return (data.calendars || []).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description || "",
  }));
}

module.exports = {
  getAvailableSlots,
  isSlotAvailable,
  bookAppointment,
  getContactAppointments,
  rescheduleAppointment,
  cancelAppointment,
  getLocationCalendars,
  TIMEZONE,
};
