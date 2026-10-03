import { WebClient } from "@slack/web-api";
import crypto from "node:crypto";
import { recordUrl } from "./salesforce";
import type { Draft, SfAccount, SfContact, Spike, UsageContext } from "./types";

const slack = () => new WebClient(process.env.SLACK_BOT_TOKEN);

const LABEL: Record<Draft["spike_type"], string> = {
  expansion: ":seedling: Expansion",
  risk: ":warning: Possible issue",
  commit: ":chart_with_upwards_trend: Approaching commit",
};

export function buildAlertBlocks(args: {
  alertId: number;
  spike: Spike;
  usage: UsageContext;
  account: SfAccount;
  contact: SfContact | null;
  draft: Draft;
  note?: string;
}) {
  const { alertId, usage, account, contact, draft, note } = args;
  const contactLine = contact
    ? `<${recordUrl(contact.Id)}|${contact.Name}>, ${contact.enrichedTitle ?? contact.Title ?? "title unknown"}${
        contact.enrichmentStatus === "not_enriched" ? " _(Clay enrichment timed out)_" : ""
      }`
    : "_No good contact in Salesforce. Worth finding one._";
  const commit = usage.commitUtilization != null ? `${Math.round(usage.commitUtilization * 100)}% of monthly commit` : "No commit on file";
  const value = String(alertId);

  return [
    { type: "header", text: { type: "plain_text", text: `Inference spike: ${account.Name}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${LABEL[draft.spike_type]}  ·  confidence ${draft.confidence.toFixed(2)}` }] },
    ...(note ? [{ type: "section", text: { type: "mrkdwn", text: `:information_source: ${note}` } }] : []),
    { type: "section", text: { type: "mrkdwn", text: draft.rep_summary } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Account*\n<${recordUrl(account.Id)}|${account.Name}>` },
        { type: "mrkdwn", text: `*Contact*\n${contactLine}` },
        { type: "mrkdwn", text: `*Run-rate*\n${commit}` },
        { type: "mrkdwn", text: `*Open opps*\n${account.openOpps.length || "None"}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*Suggested email*\n*Subject:* ${draft.email_subject}\n\`\`\`${draft.email_body}\`\`\`` } },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Mark sent" }, style: "primary", action_id: "mark_sent", value },
        { type: "button", text: { type: "plain_text", text: "Not useful" }, action_id: "not_useful", value },
        { type: "button", text: { type: "plain_text", text: "Snooze" }, action_id: "snoozed", value },
      ],
    },
  ];
}

export async function postMessage(channel: string, text: string, blocks?: unknown[]) {
  const res = await slack().chat.postMessage({ channel, text, blocks: blocks as any });
  return { channel: res.channel as string, ts: res.ts as string };
}

export async function replyInThread(channel: string, threadTs: string, text: string) {
  await slack().chat.postMessage({ channel, thread_ts: threadTs, text });
}

/** Verify a request really came from Slack (HMAC of timestamp + raw body). */
export function verifySlackSignature(rawBody: string, timestamp: string | null, signature: string | null) {
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // replay protection
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + crypto.createHmac("sha256", process.env.SLACK_SIGNING_SECRET!).update(base).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
