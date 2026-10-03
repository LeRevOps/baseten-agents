import Anthropic from "@anthropic-ai/sdk";
import type { Draft, SfAccount, SfContact, Spike, UsageContext } from "./types";

const SYSTEM = `You help account executives at an AI inference company act on customer usage changes.

You get facts about an account whose GPU usage spiked in the last 14 days. Do three things:

1. Classify the spike:
   - "expansion": sustained growth, usually a new deployment or model ramping up. Opportunity to help them scale.
   - "risk": a sudden, short, outsized jump (e.g. one day far above the rest) that looks like a runaway job, bug, or cost surprise. Offer engineering help, not a sales pitch.
   - "commit": usage is on track to exceed or nearly exhaust their contracted commit. Opportunity to right-size the contract.
   If signals conflict, pick the one with the most direct business consequence and lower your confidence.

2. Write a rep_summary for the AE: 2 sentences, plain language, include the key numbers and why it matters.

3. Write an email to the contact from the AE:
   - Short (under 90 words), warm, specific, one clear ask.
   - Never quote raw usage percentages or say "we noticed your usage". It should read as a helpful check-in, not surveillance.
   - Tone follows the classification: expansion = help scaling; risk = offer engineering help; commit = plan ahead together.
   - Sign off with "[Your name]".

Give a confidence from 0 to 1 for the classification. Be honest; ambiguous data should score below 0.7.

Respond only by calling the submit_alert tool with your answer.`;

const TOOL: Anthropic.Tool = {
  name: "submit_alert",
  description: "Submit the classification, rep summary, and outreach draft.",
  strict: true, // API validates tool arguments against the schema
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      spike_type: { type: "string", enum: ["expansion", "risk", "commit"] },
      // strict schemas reject minimum/maximum, so the 0-1 range is clamped in draftOutreach
      confidence: { type: "number", description: "Between 0 and 1" },
      rep_summary: { type: "string" },
      email_subject: { type: "string" },
      email_body: { type: "string" },
    },
    required: ["spike_type", "confidence", "rep_summary", "email_subject", "email_body"],
  },
};

export type DraftInput = {
  spike: Spike;
  usage: UsageContext;
  account: Pick<SfAccount, "Name" | "Industry" | "openOpps">;
  contact: Pick<SfContact, "Name" | "Title" | "enrichedTitle"> | null;
};

export async function draftOutreach(input: DraftInput): Promise<Draft> {
  const client = new Anthropic();
  const res = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
    max_tokens: 4000, // thinking tokens count against this
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "auto" }, // forced tool use is a 400 on this model; the prompt + strict schema do the work
    messages: [{ role: "user", content: JSON.stringify(input, null, 2) }],
  });
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Claude returned no structured output");
  const draft = block.input as Draft;
  return { ...draft, confidence: Math.min(1, Math.max(0, draft.confidence)) };
}
