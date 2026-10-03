import { NextResponse } from "next/server";
import { verifySlackSignature } from "@/lib/slack";
import { updateAlert } from "@/lib/db";

const STATUS: Record<string, string> = {
  mark_sent: "marked_sent",
  not_useful: "not_useful",
  snoozed: "snoozed",
};

const CONFIRM: Record<string, string> = {
  marked_sent: ":white_check_mark: Marked as sent. Nice.",
  not_useful: ":memo: Logged as not useful. This feeds threshold tuning.",
  snoozed: ":zzz: Snoozed.",
};

export async function POST(req: Request) {
  const raw = await req.text();
  const ok = verifySlackSignature(raw, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"));
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}");
  const action = payload.actions?.[0];
  const status = action ? STATUS[action.action_id] : undefined;
  if (!status) return new NextResponse(null, { status: 200 });

  await updateAlert(Number(action.value), { status });

  // Reply in the thread via response_url; Slack needs our 200 within 3 seconds.
  if (payload.response_url) {
    await fetch(payload.response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", replace_original: false, text: CONFIRM[status] }),
    });
  }
  return new NextResponse(null, { status: 200 });
}
