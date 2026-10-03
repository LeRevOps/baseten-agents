import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { spikeScanWorkflow } from "@/workflows/spike-alert";

// The route only authenticates and starts the workflow, then returns immediately.
// All the slow, failure-prone work happens durably inside the workflow.
async function handle(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const run = await start(spikeScanWorkflow, []);
  return NextResponse.json({ started: true, runId: run.runId });
}

export const GET = handle;   // Vercel cron
export const POST = handle;  // manual trigger during the demo
