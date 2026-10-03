# Inference spike agent

Finds accounts whose inference usage spiked in the last 14 days, pulls the account and best contact from Salesforce, finds the owning rep, has Claude classify the spike and draft outreach, and DMs the rep in Slack. Never alerts the same spike twice. Nudges the rep if nobody acts.

Stack: Next.js on Vercel, Workflow SDK (durable workflows), Supabase (stands in for the warehouse), Salesforce REST API, Slack, Claude, optional Clay.

## How it fits together

```
Vercel cron ─► /api/scan ─► spikeScanWorkflow
                              └─ for each spike: start(spikeAlertWorkflow)
                                   1 claim alert (no repeats)       Supabase
                                   2 account by Baseten_Org_Id__c    Salesforce
                                   3 pick contact (+ Clay, optional) Salesforce, Clay
                                   4 usage breakdown + rep lookup    Supabase
                                   5 classify + draft                Claude
                                   6 DM rep (or RevOps if unsure)    Slack
                                   7 sleep 48h, nudge if ignored     Workflow SDK
Slack buttons ─► /api/slack/interactions ─► spike_alerts.status
```

| File | What it does |
|---|---|
| `workflows/spike-alert.ts` | Both workflows and every step. Start here. |
| `config/spike.ts` | All thresholds in one place |
| `supabase/schema.sql` | Tables + `detect_spikes()` SQL |
| `lib/db.ts` | Dedupe (`claimAlert`), usage breakdown, rep lookup |
| `lib/salesforce.ts` | Auth, SOQL, contact-picking rules |
| `lib/claude.ts` | Classification + draft with forced structured output |
| `lib/slack.ts` | Message blocks, signature verification |
| `scripts/seed.ts` | Fake usage with 3 planted spikes + Salesforce CSVs |
| `scripts/eval.ts` | Checks Claude labels the 3 spikes correctly |

## Setup, in order

Do the credentials first. Salesforce auth is where most of the friction is.

### 1. Install
```bash
npm install
cp .env.example .env.local   # also copy to .env for the scripts
```

### 2. Anthropic (5 min) and the eval
Add `ANTHROPIC_API_KEY`, then `npm run eval`. This works with nothing else configured and is the fastest early win.

### 3. Supabase (15 min)
Create a project. In the SQL editor, run `supabase/schema.sql`. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (server-side only, never ship it to a browser).

### 4. Salesforce (45-90 min)
1. Sign up for a free Developer Edition org.
2. Setup > Object Manager > Account > Fields: create text field **Baseten Org Id** (`Baseten_Org_Id__c`), marked **External ID** and **Unique**.
3. Setup > External Client App Manager > New. Enable OAuth, enable **Client Credentials Flow**, scopes `api` and `refresh_token`. In its policies, set the **Run As** user to yourself. Copy the consumer key and secret into `SF_CLIENT_ID` / `SF_CLIENT_SECRET`. `SF_LOGIN_URL` is your My Domain URL.
   - If the UI looks different, search Salesforce Help for "client credentials flow". Salesforce has been moving from Connected Apps to External Client Apps.
4. Find your 18-character user Id (Setup > Users > your user; or run `SELECT Id FROM User WHERE Username = '...'` in Developer Console). Put it in `REP_SFDC_USER_ID`.

### 5. Seed data
```bash
npm run seed
```
Confirm the printed table shows exactly `org_003`, `org_007`, `org_011`. Then in Salesforce, use **Data Import Wizard** to import `salesforce/accounts.csv` (map Baseten Org Id) and then `salesforce/contacts.csv` (match contacts to accounts by Account Name). Accounts you import are owned by you, which is why the rep mapping works.

### 6. Slack (30 min)
1. Create a free workspace and a Slack app (api.slack.com/apps).
2. Bot token scopes: `chat:write`, `im:write`. Install to workspace. Copy `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.
3. Interactivity: on, request URL `https://YOUR-URL/api/slack/interactions`.
4. Create a `#revops-alerts` channel, invite the bot, put its channel Id in `SLACK_REVOPS_CHANNEL_ID`.
5. Your member Id (profile > ... > Copy member ID) goes in `REP_SLACK_USER_ID`. Re-run `npm run seed` after setting it.

### 7. Run it
```bash
npm run dev
curl -X POST http://localhost:3000/api/scan -H "Authorization: Bearer $CRON_SECRET"
npx workflow web          # visual run inspector: every step, input, output, retry
```
Locally, Slack buttons and Clay callbacks need a public URL: use ngrok, or just deploy (`vercel deploy`) and test there. On Vercel, add every env var in Project Settings first.

If you ever add a `proxy.ts`/middleware, exclude `.well-known/workflow` from its matcher or workflows will silently never run.

### 8. Clay (optional, half a day)
1. Create a table with a **webhook** source. Put its URL in `CLAY_WEBHOOK_URL`.
2. Add an enrichment that finds the contact's current title (from `contact_email` / `contact_name` + `company`).
3. Add an **HTTP API** column: POST to `{{callback_url}}`, header `x-callback-secret: <CLAY_CALLBACK_SECRET>`, body `{"title": "{{enriched title}}"}`.
4. Check early whether your Clay plan includes HTTP API columns. If not, the workflow still runs: it times out after `clayTimeout` and marks the contact "not enriched".

## Demo script (about 10 minutes)

1. **Data.** Show `product_usage_daily` and the three planted shapes. Show `config/spike.ts`: "These are guesses I'd tune with sales."
2. **Low-code version first (optional).** Show the n8n flow (below): "80% in an hour. Here's what it can't do."
3. **Trigger the scan.** DMs arrive. Open the Acme one and walk through it.
4. **Inspector.** `npx workflow web`: each step's input and output, retries, the child run per account.
5. **No repeats.** Trigger again. Nothing new arrives. Show `spike_alerts`.
6. **Adoption.** Click Not useful. Show the status change. "That's how I'd know if reps use this."
7. **Judgment.** Contact picking and routing are rules, not AI. Claude only does the part rules can't: reading the shape of the spike and writing the message. Low confidence goes to RevOps, not the rep.
8. **Eval.** `npm run eval`: 3/3 with known answers.

To demo the nudge live, set `nudgeAfter: "2m"` in `config/spike.ts`.

## n8n comparison (1-2 hours, optional)

Build: **Schedule Trigger** > **Postgres** node (connect to Supabase, run `select * from detect_spikes(1.5, 500)`) > **Slack** node posting each row to a channel. That's it.

What it can't do, which is the point: it re-alerts every day for two weeks (no memory), can't tell an expansion from an outage, has no Salesforce context or rep routing, and has no way to measure whether anyone acted.

## Questions this build answers

- **Why a workflow and not an API route?** The route returns in milliseconds. Clay can take minutes, the nudge waits 48 hours, and any step can fail. Each step is checkpointed, retried, and never re-run once it succeeds.
- **Duplicate runs?** Unique `(account_id, window_end)` plus a cooldown that only re-alerts if the spike escalated.
- **Clay never responds?** Durable `Promise.race` against `sleep`. Continue without enrichment and say so in the DM.
- **Bad AI output?** Forced structured output, a confidence threshold that routes to RevOps, and an eval with known answers.
- **Production at Baseten?** Real warehouse instead of Supabase, secrets management, alerting on failed runs, a Salesforce sandbox-to-prod path, and an owner for the thresholds.
