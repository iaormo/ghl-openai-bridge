# SOP: GHL-OpenAI Webhook Bridge

## Standard Operating Procedure

**Project:** GHL-OpenAI Webhook Bridge (Bella AI Chatbot)
**Client:** Breys Minglanilla Beauty & Skincare Co.
**Author:** Ian James Ormo
**Date Created:** March 6, 2026
**Last Updated:** March 6, 2026
**Version:** 1.0

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [File Structure & Code Reference](#3-file-structure--code-reference)
4. [Environment Variables](#4-environment-variables)
5. [Local Development Setup](#5-local-development-setup)
6. [Railway Deployment](#6-railway-deployment)
7. [GoHighLevel (GHL) Configuration](#7-gohighlevel-ghl-configuration)
8. [OpenAI Assistant Configuration](#8-openai-assistant-configuration)
9. [Bot Capabilities & Function Tools](#9-bot-capabilities--function-tools)
10. [Message Flow (End-to-End)](#10-message-flow-end-to-end)
11. [Loop Prevention & Deduplication](#11-loop-prevention--deduplication)
12. [Calendar Integration](#12-calendar-integration)
13. [Contact Management](#13-contact-management)
14. [Timezone Handling](#14-timezone-handling)
15. [API Endpoints Reference](#15-api-endpoints-reference)
16. [Debugging & Troubleshooting](#16-debugging--troubleshooting)
17. [Common Errors & Fixes](#17-common-errors--fixes)
18. [Maintenance & Operations](#18-maintenance--operations)
19. [Security Considerations](#19-security-considerations)
20. [Scaling & Performance](#20-scaling--performance)

---

## 1. Project Overview

### What It Does

This is a **webhook bridge** that connects **GoHighLevel (GHL)** to **OpenAI** to power an AI chatbot named **Bella** for Breys Minglanilla Beauty & Skincare Co.

When a customer sends a message on **Facebook Messenger** (through GHL), this bridge:

1. Receives the message via a webhook from GHL
2. Sends it to OpenAI's Chat Completions API (using the Bella assistant's instructions)
3. Executes any required function calls (booking appointments, updating contacts, etc.)
4. Sends the AI's reply back to GHL, which delivers it to the customer on Messenger

### Key Technologies

| Component        | Technology                          |
| ---------------- | ----------------------------------- |
| Runtime          | Node.js 20                          |
| Web Framework    | Express.js 4                        |
| AI Engine        | OpenAI Chat Completions (gpt-4o-mini) |
| Database         | PostgreSQL (Railway-hosted)         |
| Hosting          | Railway (Docker deployment)         |
| CRM / Messaging  | GoHighLevel (GHL) API v2            |
| Customer Channel | Facebook Messenger (via GHL)        |
| Timezone         | Asia/Manila (UTC+8)                 |

### Live URLs

| Resource    | URL                                                                  |
| ----------- | -------------------------------------------------------------------- |
| Health Check | `https://ghl-openai-bridge-production.up.railway.app/`              |
| Webhook URL  | `https://ghl-openai-bridge-production.up.railway.app/webhook/inbound` |
| GitHub Repo  | `https://github.com/iaormo/ghl-openai-bridge`                       |

---

## 2. System Architecture

```
Customer (Facebook Messenger)
        |
        v
GoHighLevel (GHL)
  - Receives FB message
  - Triggers workflow
  - Sends webhook POST
        |
        v
+------------------------------------------+
|  GHL-OpenAI Bridge (Railway)             |
|                                          |
|  POST /webhook/inbound                   |
|    1. Validate & extract payload         |
|    2. Loop prevention (direction check)  |
|    3. Deduplication (60s TTL)            |
|    4. Respond 200 immediately            |
|    5. Async processing begins:           |
|                                          |
|  +-- OpenAI Chat Completions API ---+    |
|  |   - System prompt (Bella)        |    |
|  |   - Conversation history (PG)    |    |
|  |   - Function calling tools       |    |
|  |   - Up to 5 tool call rounds     |    |
|  +----------------------------------+    |
|                                          |
|  +-- Function Tool Execution --------+   |
|  |   - GHL Calendar API (booking)    |   |
|  |   - GHL Contacts API (updates)    |   |
|  |   - Date/time utilities           |   |
|  +----------------------------------+   |
|                                          |
|  +-- PostgreSQL (Railway) -----------+   |
|  |   - messages table (history)      |   |
|  |   - Indexed by contact_id         |   |
|  +----------------------------------+   |
|                                          |
|  5. Send reply via GHL Conversations API |
+------------------------------------------+
        |
        v
GoHighLevel (GHL)
  - Receives reply
  - Delivers to Facebook Messenger
        |
        v
Customer sees the reply
```

### Data Flow Summary

```
Inbound:  Customer -> FB Messenger -> GHL -> Webhook -> Bridge -> OpenAI
Outbound: OpenAI -> Bridge -> GHL API -> FB Messenger -> Customer
Storage:  Bridge -> PostgreSQL (conversation history)
Actions:  OpenAI (function calls) -> Bridge -> GHL API (calendar/contacts)
```

---

## 3. File Structure & Code Reference

```
ghl-openai-bridge/
|-- .env                    # Local environment variables (NOT in git)
|-- .env.example            # Template for environment variables
|-- .gitignore              # Ignores node_modules and .env
|-- Dockerfile              # Docker build for Railway
|-- package.json            # Node.js dependencies & scripts
|-- package-lock.json       # Locked dependency versions
|-- railway.json            # Railway deployment configuration
|-- SOP.md                  # This document
|
|-- src/
    |-- index.js            # Main Express server entry point
    |-- db.js               # PostgreSQL connection & message storage
    |
    |-- routes/
    |   |-- webhook.js      # All webhook endpoints (inbound, debug, capture, test)
    |
    |-- services/
        |-- openai.js       # OpenAI Chat Completions + function tool definitions
        |-- ghl.js          # GHL Conversations API (send replies)
        |-- calendar.js     # GHL Calendar API (slots, booking, reschedule, cancel)
        |-- contacts.js     # GHL Contacts API (get, update, custom fields)
```

### File Descriptions

#### `src/index.js` — Main Server

- Initializes Express with CORS and JSON parsing
- Mounts webhook routes under `/webhook`
- Runs `initDB()` to create the messages table on startup
- Listens on `PORT` (default 3000, Railway sets this automatically)
- Health check at `GET /` returns service status and webhook URL

#### `src/db.js` — Database Layer

- Lazy-initializes PostgreSQL connection pool from `DATABASE_URL`
- Creates `messages` table with columns: `id`, `contact_id`, `role`, `content`, `created_at`
- Creates index on `(contact_id, created_at DESC)` for fast history lookups
- **`getHistory(contactId, limit)`** — Returns last N messages for conversation context (oldest first)
- **`saveMessage(contactId, role, content)`** — Stores a user or assistant message
- Gracefully handles missing `DATABASE_URL` (skips DB operations)

#### `src/routes/webhook.js` — Webhook Endpoints

- **`POST /webhook/inbound`** — Main production endpoint (see Section 10 for full flow)
- **`POST /webhook/debug`** — Synchronous debug endpoint that runs the full flow and returns results at each step
- **`POST /webhook/capture`** — Captures raw webhook payload for inspection
- **`GET /webhook/capture`** — Retrieves the last captured payload
- **`GET /webhook/test`** — Returns expected payload format

#### `src/services/openai.js` — AI Engine

- Lazy-initializes OpenAI client (prevents crash when API key is missing)
- Fetches and caches the Bella assistant's system prompt from OpenAI
- Injects fresh Manila date context + 7-day day-of-week mapping into every request
- Defines 9 function calling tools (see Section 9)
- **`chat(contactId, message)`** — Main function: loads history, calls OpenAI, handles tool calls (up to 5 rounds), saves messages, returns reply
- **`executeTool(toolCall, contactId)`** — Dispatches function calls to the appropriate service

#### `src/services/ghl.js` — GHL Message Sending

- **`sendReply(contactId, message, locationId)`** — Sends a message back to GHL via the Conversations API
- **`setChannelType(contactId, ghlMessageType)`** — Caches the channel type (FB, SMS, WhatsApp, etc.) per contact
- Default channel type is `FB` (Facebook Messenger)
- Maps GHL type integers: `11=FB`, `2=SMS`, `3=Email`, `15=IG`, `18=WhatsApp`, `6=Live_Chat`

#### `src/services/calendar.js` — Calendar Operations

- **`getAvailableSlots(startDate, endDate)`** — Gets free 30-minute slots from GHL calendar
- **`bookAppointment(contactId, slotDateTime, title)`** — Books a new appointment
- **`getContactAppointments(contactId)`** — Gets upcoming non-cancelled appointments
- **`rescheduleAppointment(appointmentId, newDateTime)`** — Reschedules an appointment
- **`cancelAppointment(appointmentId)`** — Cancels an appointment (sets status to "cancelled")
- All dates handled in Manila timezone (UTC+8)

#### `src/services/contacts.js` — Contact Management

- **`getContactInfo(contactId)`** — Retrieves contact details (name, phone, email, tags, custom fields)
- **`updateContactInfo(contactId, data)`** — Updates name, phone, and/or email
- **`updateCustomField(contactId, key, value)`** — Updates a custom field (e.g., `availed_service`)
- Handles full name splitting (first name / last name)
- Strips phone number formatting (spaces, dashes)

---

## 4. Environment Variables

### Required Variables

| Variable              | Description                              | Example                              |
| --------------------- | ---------------------------------------- | ------------------------------------ |
| `DATABASE_URL`        | PostgreSQL connection string             | `postgresql://user:pass@host:5432/db`|
| `OPENAI_API_KEY`      | OpenAI API key                           | `sk-proj-...`                        |
| `OPENAI_ASSISTANT_ID` | Existing OpenAI Assistant ID             | `asst_19Z7WGu2VRQkAawPPfJBtzel`     |
| `GHL_API_KEY`         | GHL Private Integration Token            | `pit-...`                            |

### Optional Variables (with defaults)

| Variable              | Default                        | Description                    |
| --------------------- | ------------------------------ | ------------------------------ |
| `PORT`                | `3000`                         | Server port                    |
| `NODE_ENV`            | (not set)                      | Set to `production` on Railway |
| `OPENAI_MODEL`        | `gpt-4o-mini`                  | OpenAI model to use            |
| `GHL_LOCATION_ID`     | `JYNTUGxvUZVoROmjpf50`        | GHL location ID                |
| `GHL_CALENDAR_ID`     | `6ZLEA0dTsCE67OOAmQnU`        | GHL calendar ID                |
| `GHL_TIMEZONE`        | `Asia/Manila`                  | Timezone for date handling     |
| `GHL_DEFAULT_CHANNEL` | `FB`                           | Default message channel type   |

### Where Variables Are Set

- **Local development:** `.env` file in project root
- **Railway production:** Railway dashboard > Project > Variables tab
- **`DATABASE_URL`** is automatically set by Railway when you add a PostgreSQL plugin

---

## 5. Local Development Setup

### Prerequisites

- Node.js 20+ installed
- PostgreSQL running locally (or a remote connection string)
- OpenAI API key
- GHL Private Integration Token

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/iaormo/ghl-openai-bridge.git
cd ghl-openai-bridge

# 2. Install dependencies
npm install

# 3. Create environment file
cp .env.example .env
# Edit .env with your actual values

# 4. Start development server (auto-restarts on file changes)
npm run dev

# 5. Test the health check
curl http://localhost:3000/

# 6. Test the webhook with a sample payload
curl -X POST http://localhost:3000/webhook/inbound \
  -H "Content-Type: application/json" \
  -d '{"contact_id":"test123","message":{"type":11,"body":"Hello"}}'
```

### Local Testing Tips

- The `/webhook/debug` endpoint runs the full flow synchronously and returns detailed results
- The `/webhook/capture` endpoint logs the raw payload for inspection
- Use the `/webhook/test` endpoint to see the expected payload format
- Without a valid `GHL_API_KEY`, the bot will process messages but won't send replies back to GHL

---

## 6. Railway Deployment

### Initial Setup

1. **Create a Railway account** at [railway.app](https://railway.app)
2. **Create a new project** and connect it to the GitHub repository (`iaormo/ghl-openai-bridge`)
3. **Add PostgreSQL:** Click "New" > "Database" > "PostgreSQL". Railway automatically sets `DATABASE_URL`
4. **Set environment variables** in the Railway dashboard:
   - `OPENAI_API_KEY`
   - `OPENAI_ASSISTANT_ID` = `asst_19Z7WGu2VRQkAawPPfJBtzel`
   - `GHL_API_KEY` = your GHL Private Integration Token
   - `GHL_LOCATION_ID` = `JYNTUGxvUZVoROmjpf50`
   - `GHL_CALENDAR_ID` = `6ZLEA0dTsCE67OOAmQnU`
   - `NODE_ENV` = `production`
5. **Generate a domain:** Settings > Networking > Generate Domain
   - Current domain: `ghl-openai-bridge-production.up.railway.app`

### How Deployment Works

- Railway is connected to the GitHub repository
- **Every `git push` to the `main` branch triggers an automatic deployment**
- Railway builds a Docker image using the `Dockerfile`
- The new container replaces the old one (zero-downtime with health checks)
- Typical deploy time: ~60 seconds

### Deployment Commands

```bash
# Make a code change, then:
git add -A
git commit -m "Description of change"
git push origin main

# Railway auto-deploys within ~60 seconds
# Check status at: https://ghl-openai-bridge-production.up.railway.app/
```

### Railway Configuration Files

**`Dockerfile`** — Builds the production image:
- Base: `node:20-slim`
- Installs production dependencies only (`npm ci --omit=dev`)
- Exposes port 3000
- Runs `node src/index.js`

**`railway.json`** — Railway-specific settings:
- Builder: DOCKERFILE
- Health check path: `/`
- Restart policy: ON_FAILURE (max 10 retries)

---

## 7. GoHighLevel (GHL) Configuration

### GHL Webhook Setup

1. Go to **GHL Dashboard** > **Automation** > **Workflows**
2. Create or edit a workflow
3. Add a **trigger**: "Customer Replied" or "Inbound Webhook" on the desired channel (Facebook Messenger)
4. Add an **action**: "Webhook" (or "HTTP Request")
5. Set the URL to:
   ```
   https://ghl-openai-bridge-production.up.railway.app/webhook/inbound
   ```
6. Method: **POST**
7. Content-Type: **application/json**
8. Make sure the payload includes `contact_id` and `message` fields

### GHL Webhook Payload Structure

This is what GHL sends to the webhook (actual captured payload):

```json
{
  "type": "InboundMessage",
  "locationId": "JYNTUGxvUZVoROmjpf50",
  "contact_id": "abc123def456",
  "message_id": "msg_789",
  "direction": "inbound",
  "message": {
    "type": 11,
    "body": "Hi, I want to book an appointment"
  },
  "location": {
    "id": "JYNTUGxvUZVoROmjpf50"
  }
}
```

### Key Fields the Bridge Extracts

| Field             | Extracted From                                 | Purpose                     |
| ----------------- | ---------------------------------------------- | --------------------------- |
| `contactId`       | `body.contact_id` or `body.contactId`          | Identifies the customer     |
| `message`         | `body.message.body` (nested object)            | The customer's message text |
| `locationId`      | `body.location.id` or `body.locationId`        | GHL location                |
| `messageId`       | `body.messageId` or `body.message_id`          | For deduplication           |
| `direction`       | `body.direction`                               | Loop prevention             |
| `message.type`    | `body.message.type` (integer)                  | Channel type (11=FB)        |

### GHL API Authentication

The bridge uses a **Private Integration Token (PIT)** for GHL API calls:
- Format: `pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- Passed as `Authorization: Bearer <token>` header
- API Version header: `2021-04-15` (conversations/calendar) or `2021-07-28` (contacts)

### GHL API Endpoints Used

| Action               | Method | Endpoint                                                   |
| -------------------- | ------ | ---------------------------------------------------------- |
| Send message         | POST   | `/conversations/messages`                                  |
| Get contact          | GET    | `/contacts/{contactId}`                                    |
| Update contact       | PUT    | `/contacts/{contactId}`                                    |
| Get free slots       | GET    | `/calendars/{calendarId}/free-slots`                       |
| Book appointment     | POST   | `/calendars/events/appointments`                           |
| Reschedule appt      | PUT    | `/calendars/events/appointments/{appointmentId}`           |
| Cancel appointment   | PUT    | `/calendars/events/appointments/{appointmentId}`           |
| Get contact appts    | GET    | `/contacts/{contactId}/appointments`                       |

All endpoints use base URL: `https://services.leadconnectorhq.com`

---

## 8. OpenAI Assistant Configuration

### Assistant Details

| Property     | Value                              |
| ------------ | ---------------------------------- |
| Assistant ID | `asst_19Z7WGu2VRQkAawPPfJBtzel`   |
| Model        | `gpt-4o-mini` (configurable)       |
| Name         | Bella (Breys AI Chatbot)           |

### How the Assistant's Instructions Are Used

1. On first request, the bridge fetches the assistant's instructions from the OpenAI API using `beta.assistants.retrieve()`
2. The instructions are **cached in memory** (fetched only once per server restart)
3. For every chat request, the instructions are used as the `system` message
4. A fresh **Manila date/time context** is appended to the system prompt on every request

### System Prompt Injection (Date Context)

Every request includes this appended to the system prompt:

```
CURRENT DATE/TIME (Manila, UTC+8): Friday, March 6, 2026, 2:30 PM
Upcoming days:
Friday = 2026/03/06
Saturday = 2026/03/07
Sunday = 2026/03/08
Monday = 2026/03/09
Tuesday = 2026/03/10
Wednesday = 2026/03/11
Thursday = 2026/03/12
```

This ensures the bot correctly maps day names (like "Saturday") to actual dates when booking appointments.

### Conversation History

- Last **20 messages** are loaded from PostgreSQL for each request
- Messages are stored with `role` (user/assistant) and `content`
- History provides conversation context so the bot remembers previous interactions
- Each contact has their own separate conversation history

---

## 9. Bot Capabilities & Function Tools

The bot has **9 function calling tools** that allow it to interact with GHL:

### Tool 1: `getCurrentDate`

- **Purpose:** Get the current date and time in Manila timezone
- **Parameters:** None
- **Returns:** Current date/time string and timezone
- **Usage:** Called at the start of a conversation

### Tool 2: `getContactInformation`

- **Purpose:** Retrieve the customer's existing contact info from GHL
- **Parameters:** None (uses the contact ID from the webhook)
- **Returns:** Name, phone, email, tags, custom fields

### Tool 3: `updateContactInfo`

- **Purpose:** Update the customer's name, phone, and/or email in GHL
- **Parameters:**
  - `name` (optional) — Full name (auto-split into first/last)
  - `phone` (optional) — Phone number
  - `email` (optional) — Email address
- **Trigger:** Called immediately when a customer provides their name or phone

### Tool 4: `updateCustomField`

- **Purpose:** Update a custom field on the contact record
- **Parameters:**
  - `key` (required) — Field key (e.g., `availed_service`)
  - `value` (required) — Value to set
- **Usage:** Tracks which service(s) the customer is interested in

### Tool 5: `getAvailableSlots`

- **Purpose:** Check available appointment time slots for a date
- **Parameters:**
  - `start_date` (required) — Date in `YYYY-MM-DD` format
  - `end_date` (optional) — Defaults to start_date
- **Returns:** All open 30-minute slots organized by date

### Tool 6: `appointmentBooking`

- **Purpose:** Book an appointment for the customer
- **Parameters:**
  - `date_time` (required) — ISO format with timezone (e.g., `2026-03-08T14:00:00+08:00`)
  - `service` (required) — Service being booked
  - `customer_name` (optional) — For the appointment title
  - `phone` (optional) — Customer's phone
- **Title format:** `{CustomerName} x Breys - {Service}`
- **Important:** Only called after the customer confirms the slot

### Tool 7: `getContactAppointments`

- **Purpose:** Get the customer's upcoming appointments
- **Parameters:** None
- **Returns:** List of upcoming non-cancelled appointments with date, time, and status
- **Usage:** Used for reschedule or cancellation requests

### Tool 8: `rescheduleAppointment`

- **Purpose:** Reschedule an existing appointment to a new date/time
- **Parameters:**
  - `appointment_id` (required) — The appointment to reschedule
  - `new_date_time` (required) — New date/time in ISO format

### Tool 9: `cancelAppointment`

- **Purpose:** Cancel an existing appointment
- **Parameters:**
  - `appointment_id` (required) — The appointment to cancel
- **Result:** Sets appointment status to "cancelled"

### Multi-Step Tool Calls

The bot can chain up to **5 rounds** of tool calls per message. For example:

1. Customer says "I'm John, my number is 09171234567, I want to book for Saturday"
2. Round 1: `updateContactInfo` (save name and phone)
3. Round 2: `getAvailableSlots` (check Saturday's slots)
4. Bot presents available times to the customer

---

## 10. Message Flow (End-to-End)

### Step-by-Step Flow

```
1. CUSTOMER sends a message on Facebook Messenger

2. GHL receives the message and triggers the workflow

3. GHL sends POST to /webhook/inbound with payload:
   {
     "contact_id": "abc123",
     "direction": "inbound",
     "message": { "type": 11, "body": "Hi, I want to book" }
   }

4. BRIDGE validates the request:
   a. Check direction !== "outbound" (loop prevention)
   b. Check messageId not in dedup cache (duplicate prevention)
   c. Extract contactId and message text
   d. Cache the channel type (type 11 = Facebook)

5. BRIDGE responds HTTP 200 immediately:
   { "success": true, "contactId": "abc123", "status": "processing" }

6. BRIDGE processes async (after response sent):
   a. Load assistant instructions (cached)
   b. Append Manila date context
   c. Load last 20 messages from PostgreSQL
   d. Build messages array: [system, ...history, user]
   e. Call OpenAI Chat Completions API

7. OPENAI may request function calls:
   a. Bridge executes the tool (e.g., getAvailableSlots)
   b. Tool result is added to messages
   c. OpenAI is called again with tool results
   d. Repeat up to 5 rounds

8. OPENAI returns final text reply

9. BRIDGE saves messages to PostgreSQL:
   a. Save user message
   b. Save assistant reply

10. BRIDGE sends reply to GHL via Conversations API:
    POST /conversations/messages
    { "type": "FB", "contactId": "abc123", "message": "reply text" }

11. GHL delivers the reply to the customer on Facebook Messenger
```

---

## 11. Loop Prevention & Deduplication

### The Problem

When the bridge sends a reply back to GHL, GHL may fire the webhook again for that outbound message, creating an infinite loop:

```
Customer -> GHL -> Bridge -> OpenAI -> Bridge -> GHL -> Bridge -> GHL -> ...
```

### Three Layers of Protection

#### Layer 1: Direction Filtering

```javascript
const direction = body.direction || body.messageDirection || body.type;
if (direction === "outbound" || direction === "outgoing") {
  return res.json({ skipped: true, reason: "outbound message" });
}
```

- GHL marks outbound messages with `direction: "outbound"`
- These are messages sent BY the bot, not by the customer
- Immediately skipped before any processing

#### Layer 2: Message Deduplication

```javascript
const processed = new Map(); // messageId -> timestamp
const DEDUP_TTL = 60_000;    // 60 seconds
```

- Each message ID is stored in a Map with a timestamp
- If the same message ID arrives again within 60 seconds, it's skipped
- Old entries are cleaned up automatically

#### Layer 3: Async Processing

```javascript
// Respond immediately
res.json({ success: true, contactId, status: "processing" });

// Then process async
const reply = await chat(contactId, message);
```

- The bridge responds with HTTP 200 before processing
- This prevents GHL from timing out and retrying
- Processing happens after the response is sent

---

## 12. Calendar Integration

### Calendar Details

| Property     | Value                          |
| ------------ | ------------------------------ |
| Calendar ID  | `6ZLEA0dTsCE67OOAmQnU`        |
| Type         | Service Request                |
| Slot Duration | 30 minutes                    |
| Timezone     | Asia/Manila (UTC+8)            |

### How Slot Checking Works

1. Bot calls `getAvailableSlots` with a date (e.g., `2026-03-08`)
2. Bridge converts date to epoch milliseconds using local date parsing (not UTC)
3. End date is set to start of next day (+86400000ms) to include the full day
4. GHL returns available slots as ISO timestamps
5. Bridge formats each slot for display (e.g., "2:00 PM")

### How Booking Works

1. Customer confirms a time slot
2. Bot calls `appointmentBooking` with date_time, service, customer_name
3. Bridge creates the appointment title: `{Name} x Breys - {Service}`
4. Bridge sends POST to GHL Calendar API with:
   - `calendarId`, `locationId`, `contactId`
   - `startTime` (ISO format with +08:00 offset)
   - `title`, `appointmentStatus: "new"`

### Date Parsing (Critical)

```javascript
// WRONG: new Date("2026-03-09") = March 9 at UTC midnight = March 8 in Manila
// RIGHT: Parse as local date components
function dateToTimestamp(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}
```

- `YYYY-MM-DD` strings are parsed as local date components, not UTC
- This prevents off-by-one date errors in the Manila timezone

### Timezone Handling for GHL Dates

GHL returns appointment times **without timezone offset**: `"2026-03-06 14:00:00"`

The bridge handles this by:
1. Checking if the date string contains `+` or `Z` (has timezone)
2. If not, appending `+08:00` (Manila offset)
3. All comparisons and displays use Manila timezone

---

## 13. Contact Management

### Getting Contact Info

- Uses GHL Contacts API v2021-07-28
- Returns: `id`, `firstName`, `lastName`, `fullName`, `email`, `phone`, `tags`, `customFields`

### Updating Contact Info

When a customer provides their name or phone number, the bot immediately calls `updateContactInfo`:

- **Full name** is split into first/last name (e.g., "John Doe" -> firstName: "John", lastName: "Doe")
- **Phone numbers** are cleaned (spaces and dashes removed)
- **Email** is updated if provided

### Custom Fields

The `updateCustomField` tool is used to track service preferences:

```
Key: "availed_service"
Value: "Facial Treatment, Chemical Peel"
```

- Looks up the field by key name in the contact's existing custom fields
- If found, updates by field ID
- If not found, creates with key/field_value pair

---

## 14. Timezone Handling

### Why Timezone Matters

The bot serves customers in the Philippines (Manila, UTC+8). All dates and times must be in Manila timezone to avoid:
- Booking on the wrong day (UTC midnight = previous day in some timezones)
- Showing wrong appointment times
- Day-of-week mismatches (e.g., "Saturday" mapping to the wrong date)

### How Timezone Is Handled Throughout

| Component           | Approach                                                      |
| ------------------- | ------------------------------------------------------------- |
| System prompt       | Manila date/time + 7-day day-of-week table injected every request |
| Date parsing        | `YYYY-MM-DD` parsed as local date components, not UTC         |
| Slot times          | Displayed using `toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" })` |
| Booking             | Times sent with `+08:00` offset                               |
| Reschedule          | New times sent with `+08:00` offset                           |
| GHL dates           | Timezone-less strings get `+08:00` appended                   |
| Appointment display | Formatted using Manila timezone                               |

### Day-of-Week Mapping

To prevent the bot from mapping day names to wrong dates, every request includes:

```
Friday = 2026/03/06
Saturday = 2026/03/07
Sunday = 2026/03/08
Monday = 2026/03/09
...
```

This is computed fresh for each request so it's always accurate.

---

## 15. API Endpoints Reference

### `GET /`

**Health Check** — Returns service status.

```json
{
  "service": "GHL-OpenAI Bridge",
  "status": "running",
  "webhook": "https://ghl-openai-bridge-production.up.railway.app/webhook/inbound"
}
```

### `POST /webhook/inbound`

**Main Webhook Endpoint** — Receives messages from GHL.

Request body (from GHL):
```json
{
  "contact_id": "abc123",
  "direction": "inbound",
  "message": { "type": 11, "body": "Hello" },
  "location": { "id": "JYNTUGxvUZVoROmjpf50" }
}
```

Response (immediate):
```json
{ "success": true, "contactId": "abc123", "status": "processing" }
```

### `POST /webhook/debug`

**Debug Endpoint** — Runs the full flow synchronously and returns detailed step-by-step results.

Request body:
```json
{ "contactId": "real-contact-id", "message": "Hello" }
```

Response:
```json
{
  "success": true,
  "steps": {
    "env": { "OPENAI_API_KEY": "set (sk-proj-...)", "..." : "..." },
    "payload": { "contactId": "...", "message": "..." },
    "openai": { "success": true, "reply": "AI response here" },
    "ghl": { "success": true }
  }
}
```

### `POST /webhook/capture`

**Capture Endpoint** — Saves the raw webhook payload for inspection.

### `GET /webhook/capture`

**View Captured Payload** — Returns the last captured payload.

### `GET /webhook/test`

**Test Info** — Returns the expected payload format.

---

## 16. Debugging & Troubleshooting

### Step 1: Check Health

```bash
curl https://ghl-openai-bridge-production.up.railway.app/
```

Expected: `{"service":"GHL-OpenAI Bridge","status":"running",...}`

If this fails, the server is down. Check Railway logs.

### Step 2: Check Environment Variables

Use the debug endpoint to verify all env vars are set:

```bash
curl -X POST https://ghl-openai-bridge-production.up.railway.app/webhook/debug \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}'
```

The response includes an `env` section showing which variables are set.

### Step 3: Capture GHL Payload

If the bot isn't responding, capture what GHL is actually sending:

1. Temporarily change the GHL webhook URL to `/webhook/capture`
2. Send a test message on Facebook Messenger
3. Check the captured payload:
   ```bash
   curl https://ghl-openai-bridge-production.up.railway.app/webhook/capture
   ```
4. Verify the payload has `contact_id` and `message.body`
5. Change the webhook URL back to `/webhook/inbound`

### Step 4: Check Railway Logs

1. Go to Railway dashboard > Project > Deployments
2. Click on the active deployment
3. View logs for error messages

### Step 5: Test OpenAI Directly

```bash
curl -X POST https://ghl-openai-bridge-production.up.railway.app/webhook/debug \
  -H "Content-Type: application/json" \
  -d '{"contactId":"real-ghl-contact-id","message":"What services do you offer?"}'
```

This tests the full flow including OpenAI and GHL reply.

---

## 17. Common Errors & Fixes

### Error: Bot not replying to messages

**Cause:** GHL payload structure mismatch.
**Fix:** The message text is nested at `body.message.body`, not `body.message`. Use the capture endpoint to verify.

### Error: Infinite loop (bot keeps replying to itself)

**Cause:** GHL fires webhook for outbound messages too.
**Fix:** Three-layer loop prevention (direction filter, dedup, async). Already implemented.

### Error: "thread already has active run"

**Cause:** Previous Assistants API run is still active.
**Fix:** Migrated to Chat Completions API which doesn't have this issue.

### Error: Booking on wrong day

**Cause:** `new Date("2026-03-09")` parses as UTC midnight, which is March 8 in Manila.
**Fix:** Use `dateToTimestamp()` which parses date components as local date.

### Error: Day-of-week mismatch (Saturday maps to Sunday)

**Cause:** Bot didn't have date context to know which date "Saturday" refers to.
**Fix:** Fresh Manila date + 7-day day-of-week mapping injected into every system prompt.

### Error: Reschedule shows wrong time

**Cause:** GHL returns times without timezone offset (`"2026-03-06 14:00:00"`).
**Fix:** Append `+08:00` when parsing GHL dates that don't include a timezone.

### Error: Reply sent as SMS instead of Facebook Messenger

**Cause:** Default channel type was SMS.
**Fix:** Changed default to `FB` and auto-detect from webhook payload `message.type`.

### Error: OpenAI SDK crashes on startup

**Cause:** OpenAI SDK throws if API key is missing at instantiation.
**Fix:** Lazy-initialize the client in `getClient()` function.

### Error: GHL "Invalid URL" when setting webhook

**Cause:** Extra spaces or missing `https://` in the URL.
**Fix:** Ensure the URL is exactly: `https://ghl-openai-bridge-production.up.railway.app/webhook/inbound`

### Error: Bot gets stuck after customer gives name/phone

**Cause:** Bot's system prompt references tools that weren't defined.
**Fix:** All 9 tools matching the Bella prompt must be registered.

---

## 18. Maintenance & Operations

### Redeploying

Any change pushed to GitHub automatically deploys:

```bash
# Make changes to code
git add <files>
git commit -m "Description of change"
git push origin main
# Railway auto-deploys in ~60 seconds
```

### Updating the Bot's Personality/Instructions

1. Go to [OpenAI Platform](https://platform.openai.com/assistants)
2. Find assistant `asst_19Z7WGu2VRQkAawPPfJBtzel`
3. Update the instructions
4. **Restart the Railway deployment** (or wait for next deploy) to clear the cached instructions

Note: The bridge caches the assistant instructions in memory. To pick up changes immediately, trigger a redeploy.

### Database Maintenance

The `messages` table grows over time. To manage storage:

```sql
-- Check table size
SELECT count(*) FROM messages;

-- Delete messages older than 30 days
DELETE FROM messages WHERE created_at < NOW() - INTERVAL '30 days';

-- View conversation for a specific contact
SELECT role, content, created_at FROM messages
WHERE contact_id = 'your-contact-id'
ORDER BY created_at DESC LIMIT 20;
```

Access PostgreSQL through Railway:
1. Railway dashboard > PostgreSQL plugin > "Connect" tab
2. Use the connection string with `psql` or any PostgreSQL client

### Changing the OpenAI Model

Update the `OPENAI_MODEL` environment variable in Railway:
- `gpt-4o-mini` — Fast and cheap (current, recommended)
- `gpt-4o` — More capable but slower and more expensive
- `gpt-4-turbo` — Good balance of speed and capability

### Adding a New Channel (e.g., Instagram, WhatsApp)

The bridge automatically detects the channel type from the GHL webhook payload:
- Type 11 = Facebook Messenger
- Type 15 = Instagram
- Type 18 = WhatsApp
- Type 2 = SMS
- Type 3 = Email

No code changes needed. Just set up the GHL workflow to trigger the webhook for the new channel.

### Adding a New Function Tool

1. Define the tool in the `tools` array in `src/services/openai.js`
2. Add the case to the `executeTool` switch statement
3. Implement the backend function in the appropriate service file
4. Update the assistant's instructions in OpenAI if the bot needs to know about the new tool
5. Push to GitHub (auto-deploys)

---

## 19. Security Considerations

### API Keys

- **Never commit API keys to git.** The `.env` file is in `.gitignore`
- **GHL Private Integration Token** has access to contacts, conversations, and calendars
- **OpenAI API Key** is billed per usage
- If a key is compromised, rotate it immediately in both the provider's dashboard and Railway environment variables

### Debug Endpoints

The `/webhook/debug` and `/webhook/capture` endpoints expose sensitive information:
- Environment variable names and partial values
- Raw webhook payloads with contact IDs

**For production hardening:**
- Consider adding authentication to debug endpoints
- Or remove them entirely once the bot is stable

### Data Privacy

- Customer messages are stored in PostgreSQL (conversation history)
- Contact information is retrieved from GHL (not stored locally beyond the message content)
- The database should be treated as containing PII

### Webhook Validation

Currently, the webhook accepts any POST request. For additional security:
- Consider adding a shared secret/token validation
- GHL can send a custom header with a secret value
- The bridge can verify this header before processing

---

## 20. Scaling & Performance

### Current Performance

- **Response time:** ~3-4 seconds (OpenAI processing + GHL API calls)
- **Model:** gpt-4o-mini (fastest OpenAI model)
- **Conversation history:** Last 20 messages per contact
- **Tool call rounds:** Up to 5 per message

### Optimization History

1. **Assistants API → Chat Completions API** — Reduced response time from 8-10s to 3-4s
2. **Streaming removed** — Chat Completions is fast enough without streaming
3. **Lazy initialization** — OpenAI client and DB pool created on first use, not at startup
4. **Parallel operations** — Message saving and history loading done in parallel
5. **Cached system prompt** — Assistant instructions fetched once, reused for all requests
6. **Channel type caching** — GHL channel detected from webhook, no extra API call

### If You Need to Scale

- **More contacts:** The current setup handles typical small-business load. Railway can scale vertically (more CPU/RAM)
- **Faster responses:** Upgrade to `gpt-4o` or fine-tune a model for the specific use case
- **More history:** Increase the `limit` parameter in `getHistory()` (default: 20)
- **Multiple calendars:** Add calendar selection logic to the `getAvailableSlots` function

---

## Appendix A: Complete GHL Type Mapping

| GHL Type Integer | Channel       | Bridge Type String |
| ---------------- | ------------- | ------------------ |
| 2                | SMS           | `SMS`              |
| 3                | Email         | `Email`            |
| 6                | Live Chat     | `Live_Chat`        |
| 11               | Facebook      | `FB`               |
| 15               | Instagram     | `IG`               |
| 18               | WhatsApp      | `WhatsApp`         |

## Appendix B: Database Schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  contact_id TEXT NOT NULL,
  role TEXT NOT NULL,           -- 'user' or 'assistant'
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_contact
  ON messages(contact_id, created_at DESC);
```

## Appendix C: Quick Reference Commands

```bash
# Check if server is running
curl https://ghl-openai-bridge-production.up.railway.app/

# Test the full flow (debug mode)
curl -X POST https://ghl-openai-bridge-production.up.railway.app/webhook/debug \
  -H "Content-Type: application/json" \
  -d '{"message":"What services do you offer?"}'

# Capture a GHL webhook payload
# (Set GHL webhook URL to /webhook/capture temporarily)
curl https://ghl-openai-bridge-production.up.railway.app/webhook/capture

# Check expected payload format
curl https://ghl-openai-bridge-production.up.railway.app/webhook/test

# Deploy (after making changes)
cd /Users/ianjamesormo/Documents/-git-/ghl-openai-bridge
git add -A && git commit -m "Description" && git push origin main
```

---

**End of SOP Document**
