const GHL_API_BASE = "https://services.leadconnectorhq.com";
const CALENDAR_ID = process.env.GHL_CALENDAR_ID || "6ZLEA0dTsCE67OOAmQnU";
const LOCATION_ID = process.env.GHL_LOCATION_ID || "JYNTUGxvUZVoROmjpf50";
const TIMEZONE = process.env.GHL_TIMEZONE || "Asia/Manila";

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    "Content-Type": "application/json",
    Version: "2021-04-15",
  };
}

// Get available slots for a date range
async function getAvailableSlots(startDate, endDate) {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();

  const url = `${GHL_API_BASE}/calendars/${CALENDAR_ID}/free-slots?startDate=${start}&endDate=${end}&timezone=${TIMEZONE}`;
  const response = await fetch(url, { headers: headers() });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to get slots: ${err}`);
  }

  const data = await response.json();

  // Format slots nicely
  const result = {};
  for (const [date, info] of Object.entries(data)) {
    if (date === "traceId") continue;
    result[date] = (info.slots || []).map((slot) => {
      const d = new Date(slot);
      return d.toLocaleTimeString("en-PH", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: TIMEZONE,
      });
    });
  }
  return result;
}

// Book an appointment
async function bookAppointment(contactId, slotDateTime, title) {
  const startTime = new Date(slotDateTime).toISOString();

  const response = await fetch(
    `${GHL_API_BASE}/calendars/events/appointments`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        calendarId: CALENDAR_ID,
        locationId: LOCATION_ID,
        contactId,
        startTime,
        title: title || "Appointment",
        appointmentStatus: "new",
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to book: ${err}`);
  }

  return response.json();
}

module.exports = { getAvailableSlots, bookAppointment, TIMEZONE };
