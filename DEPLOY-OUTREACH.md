# Deploy + fire the cold-outreach engine

The code is committed. These are the steps only you can do (Railway + Google are your accounts).
Whole thing is ~10 minutes. Do the one-lead self-test first, then let the 22 go.

## 1. Push (triggers Railway deploy)
```
git push origin master
```

## 2. Set Railway env vars (service: the bot)
```
GMAIL_CLIENT_ID=...           # your Google OAuth client
GMAIL_CLIENT_SECRET=...
GMAIL_USER=ian@scaleplus.io
GMAIL_LABEL=<the label Skye already watches>
OUTREACH_ENQUEUE_KEY=<pick a long random secret>
OUTREACH_TZ=Asia/Manila
OUTREACH_SEND_HOUR=18
OUTREACH_DAILY_LIMIT=22
```

## 3. Connect Gmail once (if not already)
Visit: `https://<your-bot-url>/oauth/gmail/start` and approve. (Same mailbox that answers replies.)

## 4. ONE-LEAD LIVE TEST (goes to your own inbox — no prospect touched)
```
curl -X POST https://<bot-url>/webhook/outreach/enqueue \
  -H "x-outreach-key: <secret>" -H "Content-Type: application/json" \
  --data @outreach-test-batch.json

curl -X POST https://<bot-url>/webhook/outreach/send-now \
  -H "x-outreach-key: <secret>"
```
Check ianjames.ormo@gmail.com — you should get the test email. Reply to it and confirm the
follow-ups stop for that thread (status flips to `replied`).

## 5. GO LIVE — the real 22
```
curl -X POST https://<bot-url>/webhook/outreach/enqueue \
  -H "x-outreach-key: <secret>" -H "Content-Type: application/json" \
  --data @outreach-batch.json

curl -X POST https://<bot-url>/webhook/outreach/send-now \
  -H "x-outreach-key: <secret>"
```
(Or skip send-now and they auto-send at the next 6pm Manila. Follow-ups run Day 3/6/9, stop on reply.)

## 6. Check status any time
```
curl https://<bot-url>/webhook/outreach/status -H "x-outreach-key: <secret>"
```

## 7. Turn on the daily auto-pull
The scheduled task `scaleplus-daily-us-outreach` (5:07pm daily) already sources ~22 US leads and writes
openers. Send me your `<bot-url>` + `<secret>` and I'll wire the enqueue step into that task so each
day's batch auto-loads and the bot sends it at 6pm Manila — fully hands-off.

> Note: the two batch JSON files live in the scaleplus-new folder. Run the curls from there, or pass
> the full path to `--data @/path/to/outreach-batch.json`.
