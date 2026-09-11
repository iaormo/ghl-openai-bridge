# Cold outreach: operating manual (rules from the 2026-09-11 deliverability audit)

The engine is OFF until `OUTREACH_ENABLED=true` is set on the Railway service. Everything below
is enforced in code, not by convention. Full audit: `scaleplus-new/deliverability-audit-2026-09-11.md`.

## What the bot now does

| Rule | Enforced where |
|---|---|
| Nothing sends unless `OUTREACH_ENABLED=true` | outreach.js `runTick` |
| Verification gate: Level 1 (ZeroBounce "valid") or Level 2 (on the company's own site + MX + catch-all). No verifier key = nothing eligible. | deliverability.js `verifyEmail`, run at enqueue and again if older than 30 days |
| Level 2 at most 20% of a day's initial sends | outreach.js `runTick` |
| One email per 5-minute tick, random 4–11 min gap after each send, max 6 per hour | outreach.js |
| Daily caps: `OUTREACH_DAILY_LIMIT` initial (default 5, hard cap 30), `OUTREACH_FOLLOWUP_DAILY_LIMIT` (default 20) | outreach.js |
| 09:00–16:00 in the recipient's timezone (`tz` on the lead, default `America/New_York`). Initial Mon–Thu, follow-ups Mon–Fri | outreach.js `inRecipientWindow` |
| Day 0 → Day 4 → Day 10, two follow-ups max, same thread, stop on reply | outreach.js `sendOneFollowup` |
| Bounces: every Gmail DSN is parsed. Failure → address suppressed (`hard_bounce` / `policy_block`), domain suppressed when it does not exist. Delay → lead quarantined; released after 72h with no failure; follow-up clock restarts | deliverability.js `processDsn`, gmail.js poller |
| Health gate before every send: RED pauses outbound (sticky), YELLOW halves the caps | deliverability.js `canSend` |
| Warm-up pool mail (labels matching "warm" or "Pipl.ai", known pool domains, the hyphenated tracking token) is never answered by Skye | gmail.js poller |
| Clients (clients.md) and suppressed domains can never be cold-emailed | suppression.js `isSuppressed` |
| Winback is disabled by policy (max 3 emails per recipient in 6 months) | outreach.js |
| Pre-audit leads (298 "active" July rows) frozen once at first boot | outreach.js `initOutreach` |
| Bounces from the audit seeded once at first boot | data/suppression-seed.json |

## Thresholds (rolling 7 days)

| Metric | YELLOW (halve caps) | RED (auto-pause) |
|---|---|---|
| Hard bounces | ≥2% (or any, under 10 sends) | >4%, or 2+ in 24h |
| Deferrals | ≥5% | >10% |
| Opt-outs | ≥2% | >5% |
| Reply rate (14d, ≥30 sends) | <3% | manual call |
| Postmaster spam rate (entered weekly) | ≥0.01% | ≥0.1% or non-compliant |
| Any DSN mentioning spam / reputation / policy URL | | RED immediately |
| SPF / DKIM / DMARC on scaleplus.io changed or missing | DMARC weak | RED |

## Railway env vars

```
OUTREACH_ENABLED=false            # flip to true on restart day (Mon 2026-09-14)
OUTREACH_DAILY_LIMIT=3            # 3 → 5 → 8 → 10 per the 14-day plan; hard cap 30
OUTREACH_FOLLOWUP_DAILY_LIMIT=20
OUTREACH_TZ=Asia/Manila           # only used for "today" in the daily caps
OUTREACH_DEFAULT_LEAD_TZ=America/New_York
OUTREACH_ENQUEUE_KEY=<secret>
ZEROBOUNCE_API_KEY=<key>          # required; without it nothing is eligible
NEVERBOUNCE_API_KEY=<key>         # optional second opinion on "unknown"
GMAIL_USER=<the OUTREACH mailbox>  # move this off ian@ once the second Workspace user exists
```

## Endpoints (all under /webhook)

| Method | Path | Auth | What |
|---|---|---|---|
| GET | /outreach/status | none | queue counts, caps, next send time, paused state |
| GET | /outreach/health | none | the weekly dashboard: metrics + GREEN/YELLOW/RED + reasons |
| POST | /outreach/verify | x-outreach-key | `{ leads:[{email, source}] }` → verification result per address, nothing enqueued |
| POST | /outreach/enqueue | x-outreach-key | `{ leads:[...] }` — each lead: email, firstName, company, subject, opener, **tz**, **source**, **sourceUrl**. Returns added / rejected with reasons |
| POST | /outreach/send-now | x-outreach-key | sends ONE initial email now (still gated by health, verification, caps) |
| POST | /outreach/pause | x-outreach-key | `{ reason }` |
| POST | /outreach/resume | x-outreach-key | `{ dailyLimit?: 3, force?: false }` — refused while any non-pause RED condition holds |
| POST | /outreach/postmaster | x-outreach-key | `{ spamRate: 0.0, compliant: true }` — record the weekly Postmaster reading |

## Weekly routine (Fridays)

1. `GET /webhook/outreach/health` — read status and reasons.
2. Open Postmaster Tools → scaleplus.io → Compliance status and Spam. `POST /outreach/postmaster` with what you saw.
3. Run `scaleplus-new/deliverability-dns-check.sh`.
4. If GREEN and the plan allows, raise `OUTREACH_DAILY_LIMIT`. If YELLOW, hold. If RED, fix the cause, write it down, then `POST /outreach/resume` with half the previous limit.

## Deploy

```
git push origin master        # Railway auto-deploys the skye service
```
Then check the deploy log for: `Deliverability: seeded 22 address(es) and 6 domain(s)`,
`Outreach: froze 298 pre-audit lead(s)`, and `Outreach scheduler started — DISABLED`.
