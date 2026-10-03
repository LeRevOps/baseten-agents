# Inference spike agent

Finds accounts whose inference usage spiked, pulls the account and best contact from Salesforce, finds the owning rep, has Claude classify the spike and draft outreach, and DMs the rep in Slack with buttons. It never alerts the same spike twice, and it nudges the rep if nobody acts.

Detection and routing are rules. Claude does only the part rules can't: reading the shape of a spike and writing the message.

**Stack:** Next.js on Vercel, Workflow SDK (durable workflows), Supabase Postgres (stands in for a warehouse), Salesforce REST API, Slack, Claude. Clay enrichment is optional.

## How it works

```
Vercel cron ─► /api/scan ─► spikeScanWorkflow
                              └─ for each spike: start(spikeAlertWorkflow)
                                   1 claim alert (no repeats)       Supabase
                                   2 account by Baseten_Org_Id__c    Salesforce
                                   3 pick contact (+ Clay, optional) Salesforce, Clay
                                   4 usage breakdown + rep lookup    Supabase
                                   5 classify + draft                Claude
                                   6 DM the rep, or RevOps if unsure Slack
                                   7 sleep 48h, nudge if ignored     Workflow SDK
Slack buttons ─► /api/slack/interactions ─► spike_alerts.status
```

| File | Role |
|---|---|
| `workflows/spike-alert.ts` | Both workflows and every step. Start here. |
| `config/spike.ts` | Every threshold in one place |
| `supabase/schema.sql` | Tables, row-level security, and the `detect_spikes()` SQL function |
| `lib/db.ts` | Dedupe (`claimAlert`), usage breakdown, rep lookup |
| `lib/salesforce.ts` | OAuth client credentials, SOQL, contact-picking rules |
| `lib/claude.ts` | Classification and drafting with schema-validated structured output |
| `lib/slack.ts` | Block Kit messages, request signature verification |
| `scripts/seed.ts` | 60 days of fake usage with 3 planted spikes, plus Salesforce import CSVs |
| `scripts/eval.ts` | Checks Claude labels the 3 planted spikes correctly and keeps usage out of customer emails |

## Design decisions

- **A durable workflow, not an API route.** The route returns in milliseconds. A Clay lookup can take minutes, the nudge waits 48 hours, and any step can fail. Each step is checkpointed, retried, and never re-run once it succeeds.
- **One child run per spike.** A slow or failing account can't block the others.
- **Detection is SQL.** `detect_spikes()` compares the last 14 days to the prior 28 and requires both a relative lift (1.5x) and an absolute increase (500 GPU minutes/day). Either bar alone produces false positives in one direction.
- **Rules for contacts and routing, AI for judgment.** Contact picking prefers the most recently active technical title; routing follows the Salesforce owner. Both are auditable. Claude only classifies (expansion, risk, commit) and writes.
- **Two outputs with different audiences.** The rep gets the numbers. The customer email never mentions usage, GPU figures, dates, spikes, or which models they run.
- **Structured output through a strict tool schema.** The API validates Claude's arguments against the schema; a missing tool call is a hard failure.
- **Failure routes to a human.** Low confidence (< 0.7), no rep mapping, no CRM match, and exhausted retries all go to a RevOps channel. Nothing is dropped silently.
- **Adoption is measured.** Button clicks write `spike_alerts.status` (`marked_sent`, `not_useful`, `snoozed`), so you can see whether reps use the alerts.

## When low-code is the right call

The quick version of this agent is a three-node n8n flow: a schedule trigger, a Postgres node running `select * from detect_spikes(1.5, 500)`, and a Slack node posting each row. That gets alerts out in an hour, and for a plain "tell me when X crosses Y" notification it is the right tool.

It stops being enough where this build starts:

| Need | Quick low-code flow | This build |
|---|---|---|
| Don't repeat | Re-alerts every day while the spike stays in the window | Unique constraint plus cooldown that only re-alerts on escalation |
| Tell expansion from an outage | Can't. Every spike looks the same | Claude reads the shape; low confidence goes to a human |
| Who owns it | One channel, no CRM context | Salesforce account, best contact, and owner routing |
| Survive failure and long waits | A failed node restarts the run or drops it | Checkpointed steps, retries, a 48-hour durable wait |
| Know whether it helped | Nothing | Button clicks are an adoption signal |

The split I'd use in practice:

- **Low-code (n8n, Zapier, Make):** simple notifications, glue between two tools, and prototypes to prove demand before building anything durable.
- **Clay:** enrichment, where its provider waterfall beats anything worth building. Here it fills in a contact's current title, with the workflow continuing if Clay never answers.
- **Custom (this repo):** state, durable waits, branching on judgment, and measurement.

## Reliability and security

- **No repeats, two layers.** A unique `(account_id, window_end)` constraint stops same-day reruns at the database. A 14-day cooldown stops the same spike on later days unless its lift grew 1.5x. Failed alerts don't count toward the cooldown, so the next scan retries them.
- **Retries.** A thrown error is retried (3 attempts by default). Salesforce 4xx responses throw `FatalError` because retrying can't fix bad credentials; 429 and 5xx are retried.
- **Scan endpoint** requires `CRON_SECRET` and rejects everything while it is unset.
- **Slack requests** are verified with an HMAC signature, a 5-minute replay window, and a constant-time compare.
- **Secrets stay server-side.** The Supabase service-role key bypasses row-level security, so it is never exposed to a browser. Tables have RLS enabled with no policies.

## Evaluation

```bash
npm run eval
```

Runs the three planted spike shapes through Claude and checks that each is labeled correctly (expansion, risk, commit) and that the customer email contains no usage details. It needs only `ANTHROPIC_API_KEY`. It does not test routing or email quality beyond the leak check.

## Running it

**Prerequisites**

- Node 20+, an Anthropic API key
- A Supabase project
- A Salesforce org (a free Developer Edition works) with:
  - a text field on Account, `Baseten_Org_Id__c`, marked **External ID** and **Unique**
  - an External Client App with the OAuth **Client Credentials Flow** enabled, scopes `api` and `refresh_token`, and a **Run As** user
- A Slack app with bot scopes `chat:write` and `im:write`, interactivity pointed at `/api/slack/interactions`, and a `#revops-alerts` channel the bot is in

**Setup**

```bash
npm install
cp .env.example .env.local   # Next.js reads this
cp .env.example .env         # the scripts read this
# fill in the values (see below)

# run supabase/schema.sql in the Supabase SQL editor
npm run seed                 # prints the spikes it planted: org_003, org_007, org_011
# import salesforce/accounts.csv, then contacts.csv, with Data Import Wizard
npm run eval
```

**Run**

```bash
npm run dev
curl -X POST http://localhost:3000/api/scan -H "Authorization: Bearer $CRON_SECRET"
npx workflow web             # visual inspector: every step, input, output, retry
```

Slack buttons and Clay callbacks need a public URL, so use a tunnel or deploy (`vercel deploy`). On Vercel, add every variable under Project Settings first. The daily cron is defined in `vercel.json`.

If you add a `proxy.ts` or middleware, exclude `.well-known/workflow` from its matcher, or workflows will silently never run.

**Environment**

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Database (service key is server-side only) |
| `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET` | Salesforce My Domain URL and External Client App credentials |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_REVOPS_CHANNEL_ID` | Slack |
| `CRON_SECRET` | Required. Protects `/api/scan` |
| `REP_SFDC_USER_ID`, `REP_SLACK_USER_ID`, `REP_NAME` | Seeding: maps the demo accounts' owner to a Slack user |
| `APP_BASE_URL` | Public base URL for callbacks |
| `CLAY_WEBHOOK_URL`, `CLAY_CALLBACK_SECRET` | Optional Clay enrichment. Leave blank to skip it |

## Tuning

Every threshold lives in `config/spike.ts`: lift and absolute-increase bars, cooldown, re-alert multiplier, confidence floor, Clay timeout, nudge delay. They are starting guesses, meant to be tuned with sales against real usage. Set `nudgeAfter: "2m"` to watch the follow-up happen live.

## Optional: Clay enrichment

If `CLAY_WEBHOOK_URL` is set, the workflow sends the contact to a Clay table and waits for the result through a webhook, racing it against a timeout (`Promise.race` with `sleep`). If Clay never answers, the alert goes out anyway and says the contact wasn't enriched. Clay's side needs a table with a webhook source, a title enrichment, and an HTTP API column that POSTs back to the callback URL with an `x-callback-secret` header. HTTP API columns may require a paid Clay plan.

## Known limitations

- Spike thresholds and the 0.7 confidence floor are untuned. The model's confidence is self-reported, not calibrated.
- The Snooze button records a status; it doesn't suppress anything beyond the existing cooldown.
- `reps.manager_slack_id` is stored but nothing escalates to a manager yet.
- Anyone who can see an alert message can click its buttons.
- A new Salesforce token is requested on every query. Fine at this scale; cache it for production.
- Supabase stands in for the warehouse. A production version would query the real warehouse, use a secrets manager, alert on failed runs, and promote through a Salesforce sandbox first.
