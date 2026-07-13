// Meeting confirmation + reminder cadence. Watches the ScalePlus GHL calendar and emails each
// booked contact — as Ian, from the location's email (info@scaleplus.io) — with a warm
// confirmation on booking, then a reminder ~1 day before and a final nudge ~1 hour before.
// Covers EVERY booking on the calendar (Skye's and manual ones), tracked so nothing double-sends.

const { getContactInfo } = require("./contacts");
const { TIMEZONE } = require("./calendar");
const { wasReminderSent, markReminderSent, getSetting, setSetting } = require("../db");

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const CALENDAR_ID = process.env.GHL_CALENDAR_ID || "hpj5HNU9F20BClTjiVTY";
const LOCATION_ID = process.env.GHL_LOCATION_ID || "GfDBeSbJmjBtcqGK6vXN";
const FROM = process.env.GHL_FROM_EMAIL || "Ian <info@scaleplus.io>";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    "Content-Type": "application/json",
    Version: "2021-04-15",
  };
}

// GHL start times can be epoch ms, ISO, or "YYYY-MM-DD HH:mm:ss" (Manila, no tz) — normalize.
function parseApptTime(raw) {
  if (typeof raw === "number") return new Date(raw);
  const s = String(raw);
  if (/^\d+$/.test(s)) return new Date(Number(s));
  return s.includes("+") || s.includes("Z") ? new Date(s) : new Date(s + "+08:00");
}

// e.g. "Friday, July 11 at 2:00 PM"
function when(raw) {
  const d = parseApptTime(raw);
  const date = d.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric", timeZone: TIMEZONE });
  const time = d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIMEZONE });
  return `${date} at ${time}`;
}

// ---------- email templates (warm, human, signed Ian) ----------
function tpl(kind, name, w) {
  const first = name || "there";
  if (kind === "confirmation") {
    return {
      subject: `You're booked, ${first} — looking forward to it`,
      text:
        `Hey ${first},\n\nYou're all set — I've got us down for ${w}.\n\n` +
        `On the call we'll keep it relaxed: I'll look at your setup and show you exactly where the biggest time and money wins are. You'll walk away with a clear picture either way.\n\n` +
        `Nothing to prepare — just bring the one thing eating most of your time right now. Need to move it? Just reply to this email.\n\nTalk soon,\nIan\nScalePlus`,
    };
  }
  if (kind === "day_before") {
    return {
      subject: `Quick reminder — our call tomorrow`,
      text:
        `Hey ${first},\n\nQuick heads-up that our call is tomorrow, ${w} — really looking forward to it. ` +
        `Come as you are, no prep needed. If tomorrow stopped working, just reply here and we'll find a better time.\n\nSee you soon,\nIan`,
    };
  }
  return {
    subject: `See you in a bit, ${first}`,
    text:
      `Hey ${first},\n\nWe're on in about an hour (${w}). The join link is in your calendar invite — see you there!\n\nIan`,
  };
}

// Send an email to a contact via GHL (from the location's email; body signs off as Ian).
async function sendEmail(contactId, subject, text) {
  const payload = {
    type: "Email",
    contactId,
    subject,
    message: text,
    html: text.replace(/\n/g, "<br>"),
    emailFrom: FROM,
  };
  const res = await fetch(`${GHL_API_BASE}/conversations/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`GHL send email ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// All upcoming (non-cancelled) appointments on the calendar within the next `windowMs`.
async function getUpcomingAppointments(windowMs) {
  const now = Date.now();
  const url = `${GHL_API_BASE}/calendars/events?locationId=${LOCATION_ID}&calendarId=${CALENDAR_ID}&startTime=${now}&endTime=${now + windowMs}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    console.warn("Reminder: fetch events failed:", res.status, (await res.text()).slice(0, 160));
    return [];
  }
  const data = await res.json();
  return (data.events || []).filter((e) => (e.appointmentStatus || e.status) !== "cancelled");
}

// Which touches are due for an appointment, by time-until-start.
function dueTouches(timeUntil) {
  const t = [];
  if (timeUntil > 0) t.push("confirmation"); // due the moment we first see the booking
  if (timeUntil <= DAY && timeUntil > HOUR) t.push("day_before");
  if (timeUntil <= HOUR && timeUntil > 0) t.push("hour_before");
  return t;
}

async function processAppointment(appt) {
  const contactId = appt.contactId;
  const raw = appt.startTime || appt.start;
  if (!contactId || !raw || !appt.id) return;
  const timeUntil = parseApptTime(raw).getTime() - Date.now();
  if (timeUntil <= 0) return;

  const pending = [];
  for (const kind of dueTouches(timeUntil)) {
    if (!(await wasReminderSent(appt.id, kind))) pending.push(kind);
  }
  if (!pending.length) return;

  let info;
  try {
    info = await getContactInfo(contactId);
  } catch (e) {
    console.warn(`Reminder: contact ${contactId} fetch failed:`, e.message);
    return;
  }
  // No email on file → can't send; mark as handled so we don't re-check forever.
  if (!info || !info.email) {
    for (const kind of pending) await markReminderSent(appt.id, kind);
    return;
  }
  const name = info.firstName || String(info.fullName || "").split(" ")[0] || "";
  const w = when(raw);

  for (const kind of pending) {
    const { subject, text } = tpl(kind, name, w);
    try {
      await sendEmail(contactId, subject, text);
      await markReminderSent(appt.id, kind);
      console.log(`Reminder: sent ${kind} to ${info.email} — appt ${appt.id} (${w})`);
    } catch (e) {
      console.warn(`Reminder: send ${kind} failed for appt ${appt.id}:`, e.message);
    }
  }
}

// On first ever run, mark existing upcoming bookings' CONFIRMATION as already sent, so we don't
// blast retroactive "you're booked" emails at people who booked before this feature existed.
// (Their day-before / hour-before reminders still fire naturally.)
async function seedIfNeeded(appts) {
  if (await getSetting("reminder_seeded")) return;
  let n = 0;
  for (const a of appts) {
    if (a.id) { await markReminderSent(a.id, "confirmation"); n++; }
  }
  await setSetting("reminder_seeded", "1");
  console.log(`Reminder: seeded ${n} existing booking(s) — no retroactive confirmations will send`);
}

async function runReminderPass() {
  if (!process.env.GHL_API_KEY) return;
  try {
    const appts = await getUpcomingAppointments(2 * DAY); // look ahead 2 days
    await seedIfNeeded(appts);
    for (const a of appts) await processAppointment(a);
  } catch (e) {
    console.error("Reminder pass error:", e.message);
  }
}

function startReminderScheduler(intervalMs = 5 * 60 * 1000) {
  if (!process.env.GHL_API_KEY) {
    console.log("Reminder scheduler not started (GHL_API_KEY not set)");
    return;
  }
  console.log(`Reminder scheduler started — checking bookings every ${intervalMs / 60000} min`);
  runReminderPass();
  setInterval(() => runReminderPass(), intervalMs);
}

module.exports = { startReminderScheduler, runReminderPass, getUpcomingAppointments };
