import { sleep, createWebhook, FatalError } from "workflow";
import { start } from "workflow/api";
import { SPIKE_CONFIG } from "@/config/spike";
import * as dbLib from "@/lib/db";
import * as sf from "@/lib/salesforce";
import * as slack from "@/lib/slack";
import { draftOutreach } from "@/lib/claude";
import type { Draft, SfAccount, SfContact, Spike, UsageContext } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Workflow 1: the daily scan. Finds spikes and launches one durable   */
/* child run per spike, so one slow or failing account never blocks    */
/* the others.                                                          */
/* ------------------------------------------------------------------ */
export async function spikeScanWorkflow() {
  "use workflow";
  const spikes = await findSpikes();
  const windowEnd = await todayIso();
  for (const spike of spikes) {
    await launchAlert(spike, windowEnd);
  }
  return { spikesFound: spikes.length };
}

/* ------------------------------------------------------------------ */
/* Workflow 2: one alert, end to end. Every await below is a durable    */
/* checkpoint: if Slack fails, Salesforce is not re-queried.            */
/* ------------------------------------------------------------------ */
export async function spikeAlertWorkflow(spike: Spike, windowEnd: string) {
  "use workflow";

  // 1. No repeats
  const alertId = await claim(spike, windowEnd);
  if (alertId === null) return { result: "skipped: already alerted" };

  // 2. CRM context (join product org id -> Salesforce Account)
  const account = await fetchAccount(spike.account_id);
  if (!account) {
    await routeToRevOps(alertId, `Usage spike on org \`${spike.account_id}\` (${spike.lift}x) but no Salesforce account matches it. Fix the mapping.`);
    return { result: "routed: no CRM match" };
  }

  // 3. Contact, optionally enriched by Clay (durable wait with timeout)
  let contact = await fetchContact(account.Id);
  const cfg = await runtimeConfig();
  if (contact && cfg.clayEnabled) {
    contact = await enrichWithClay(contact, account);
  }

  // 4. Usage detail + rep lookup
  const usage = await fetchUsage(spike.account_id);
  const rep = await findRep(account.OwnerId);

  // 5. Claude: classify + draft
  const draft = await classifyAndDraft(spike, usage, account, contact);

  // 6. Deliver: rep if we're confident and know who they are, RevOps otherwise
  const lowConfidence = draft.confidence < SPIKE_CONFIG.minConfidence;
  const destination = rep && !lowConfidence ? rep.slack_user_id : null;
  const note = !rep
    ? "No rep mapping for this account owner, so this went to RevOps."
    : lowConfidence
      ? `Low confidence classification, so RevOps is reviewing before ${rep.name} sees it.`
      : undefined;
  const posted = await deliver(alertId, destination, { alertId, spike, usage, account, contact, draft, note });

  // 7. Durable follow-up: sleeps at zero compute cost, then nudges if nobody acted
  if (destination) {
    await sleep(SPIKE_CONFIG.nudgeAfter);
    await nudgeIfIgnored(alertId, posted.channel, posted.ts);
  }

  return { result: "delivered", alertId, spikeType: draft.spike_type };
}

/* --------------------------- Clay ---------------------------------- */
async function enrichWithClay(contact: SfContact, account: SfAccount): Promise<SfContact> {
  // Workflow-level (not a step): uses workflow primitives.
  // The webhook URL is public; the token in it is the only built-in auth,
  // so Clay also sends a shared secret header that we verify below.
  using webhook = createWebhook();
  await webhook.getConflict(); // make sure the URL is registered before Clay can call it
  await sendToClay(contact, account, webhook.url);

  const outcome = await Promise.race([
    webhook.then(async (req) => ({
      kind: "clay" as const,
      secret: req.headers.get("x-callback-secret"),
      body: (await req.json()) as { title?: string; seniority?: string },
    })),
    sleep(SPIKE_CONFIG.clayTimeout).then(() => ({ kind: "timeout" as const })),
  ]);

  if (outcome.kind === "timeout") return { ...contact, enrichmentStatus: "not_enriched" };
  if (!(await isValidClaySecret(outcome.secret))) return { ...contact, enrichmentStatus: "not_enriched" };
  return { ...contact, enrichedTitle: outcome.body.title ?? contact.Title, enrichmentStatus: "enriched" };
}

/* --------------------------- Steps --------------------------------- */
/* Steps: full Node.js access, automatically retried, results cached.   */

async function findSpikes(): Promise<Spike[]> {
  "use step";
  return dbLib.detectSpikes();
}

async function todayIso(): Promise<string> {
  "use step";
  return new Date().toISOString().slice(0, 10);
}

async function runtimeConfig() {
  "use step";
  return { clayEnabled: Boolean(process.env.CLAY_WEBHOOK_URL) };
}

async function launchAlert(spike: Spike, windowEnd: string) {
  "use step";
  await start(spikeAlertWorkflow, [spike, windowEnd]);
}

async function claim(spike: Spike, windowEnd: string) {
  "use step";
  return dbLib.claimAlert(spike, windowEnd);
}

async function fetchAccount(orgId: string) {
  "use step";
  try {
    return await sf.getAccountByOrgId(orgId);
  } catch (err) {
    // Bad credentials won't fix themselves: stop instead of retrying forever
    if (String(err).includes("auth failed")) throw new FatalError(String(err));
    throw err;
  }
}

async function fetchContact(accountId: string) {
  "use step";
  return sf.pickContact(accountId);
}

async function sendToClay(contact: SfContact, account: SfAccount, callbackUrl: string) {
  "use step";
  const res = await fetch(process.env.CLAY_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contact_name: contact.Name,
      contact_email: contact.Email,
      company: account.Name,
      callback_url: callbackUrl, // Clay's HTTP API column POSTs results here
    }),
  });
  if (!res.ok) throw new Error(`Clay webhook failed: ${res.status}`);
}

async function isValidClaySecret(secret: string | null) {
  "use step"; // runs in a step so the secret never lands in the workflow event log
  return Boolean(secret) && secret === process.env.CLAY_CALLBACK_SECRET;
}

async function fetchUsage(accountId: string) {
  "use step";
  return dbLib.getUsageContext(accountId);
}

async function findRep(ownerId: string) {
  "use step";
  return dbLib.lookupRep(ownerId);
}

async function classifyAndDraft(spike: Spike, usage: UsageContext, account: SfAccount, contact: SfContact | null): Promise<Draft> {
  "use step";
  return draftOutreach({
    spike,
    usage,
    account: { Name: account.Name, Industry: account.Industry, openOpps: account.openOpps },
    contact: contact ? { Name: contact.Name, Title: contact.Title, enrichedTitle: contact.enrichedTitle } : null,
  });
}

async function deliver(
  alertId: number,
  repSlackId: string | null,
  args: Parameters<typeof slack.buildAlertBlocks>[0]
) {
  "use step";
  const channel = repSlackId ?? process.env.SLACK_REVOPS_CHANNEL_ID!;
  const blocks = slack.buildAlertBlocks(args);
  const posted = await slack.postMessage(channel, `Inference spike: ${args.account.Name}`, blocks);
  await dbLib.updateAlert(alertId, {
    status: repSlackId ? "sent_to_rep" : "routed_to_revops",
    spike_type: args.draft.spike_type,
    confidence: args.draft.confidence,
    slack_channel: posted.channel,
    slack_ts: posted.ts,
  });
  return posted;
}

async function routeToRevOps(alertId: number, text: string) {
  "use step";
  await slack.postMessage(process.env.SLACK_REVOPS_CHANNEL_ID!, text);
  await dbLib.updateAlert(alertId, { status: "skipped_no_owner" });
}

async function nudgeIfIgnored(alertId: number, channel: string, ts: string) {
  "use step";
  const status = await dbLib.getAlertStatus(alertId);
  if (status === "sent_to_rep") {
    await slack.replyInThread(channel, ts, "Quick nudge: this one's still open. Mark it sent, snooze it, or tell me it's not useful so I get smarter.");
  }
}
