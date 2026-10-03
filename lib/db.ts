import { createClient } from "@supabase/supabase-js";
import { SPIKE_CONFIG } from "@/config/spike";
import type { Spike, UsageContext, Rep } from "./types";

export function db() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}

const isoDay = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
const DAY = 86_400_000;

export async function detectSpikes(): Promise<Spike[]> {
  const { data, error } = await db().rpc("detect_spikes", {
    lift_threshold: SPIKE_CONFIG.liftThreshold,
    min_abs_increase: SPIKE_CONFIG.minAbsIncrease,
  });
  if (error) throw new Error(`detect_spikes failed: ${error.message}`);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    account_id: String(r.account_id),
    recent_avg: Number(r.recent_avg),
    baseline_avg: Number(r.baseline_avg),
    lift: Number(r.lift),
  }));
}

/**
 * The "no repeats" logic. Returns the new alert id, or null if this spike should not alert.
 * Layer 1: unique (account_id, window_end) blocks same-day reruns.
 * Layer 2: cooldown blocks the same spike on later days unless it escalated.
 */
export async function claimAlert(spike: Spike, windowEnd: string): Promise<number | null> {
  const client = db();
  const since = new Date(Date.now() - SPIKE_CONFIG.cooldownDays * DAY).toISOString();
  const { data: recent } = await client
    .from("spike_alerts")
    .select("lift")
    .eq("account_id", spike.account_id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);

  const last = recent?.[0];
  if (last && spike.lift < Number(last.lift) * SPIKE_CONFIG.reAlertLiftMultiplier) return null;

  const { data, error } = await client
    .from("spike_alerts")
    .insert({ account_id: spike.account_id, window_end: windowEnd, lift: spike.lift })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return null; // unique violation: another run already claimed it
    throw new Error(`claimAlert failed: ${error.message}`);
  }
  return data.id as number;
}

export async function getUsageContext(accountId: string): Promise<UsageContext> {
  const client = db();
  const { data, error } = await client
    .from("product_usage_daily")
    .select("usage_date, deployment_id, model_name, gpu_minutes")
    .eq("account_id", accountId)
    .gte("usage_date", isoDay(42 * DAY));
  if (error) throw new Error(error.message);

  const cutRecent = isoDay(14 * DAY);
  const byDep = new Map<string, { model: string; recent: number; base: number; first: string }>();
  const byDay = new Map<string, number>();

  for (const r of data ?? []) {
    const mins = Number(r.gpu_minutes);
    const d = byDep.get(r.deployment_id) ?? { model: r.model_name, recent: 0, base: 0, first: r.usage_date };
    if (r.usage_date < d.first) d.first = r.usage_date;
    if (r.usage_date >= cutRecent) d.recent += mins;
    else d.base += mins;
    byDep.set(r.deployment_id, d);
    byDay.set(r.usage_date, (byDay.get(r.usage_date) ?? 0) + mins);
  }

  const breakdown = [...byDep.entries()]
    .map(([id, d]) => ({
      deployment_id: id,
      model_name: d.model,
      first_seen: d.first,
      recent_avg: Math.round(d.recent / 14),
      baseline_avg: Math.round(d.base / 28),
    }))
    .sort((a, b) => b.recent_avg - b.baseline_avg - (a.recent_avg - a.baseline_avg));

  let maxSingleDay = 0;
  let maxSingleDayDate = "";
  for (const [day, v] of byDay) {
    if (v > maxSingleDay) {
      maxSingleDay = Math.round(v);
      maxSingleDayDate = day;
    }
  }

  const { data: contract } = await client.from("contracts").select("*").eq("account_id", accountId).maybeSingle();
  const recentDaily = breakdown.reduce((s, d) => s + d.recent_avg, 0);

  return {
    breakdown,
    maxSingleDay,
    maxSingleDayDate,
    commitUtilization: contract
      ? Math.round(((recentDaily * 30) / Number(contract.monthly_commit_gpu_minutes)) * 100) / 100
      : null,
    contractEnd: contract?.contract_end ?? null,
  };
}

export async function lookupRep(sfdcUserId: string): Promise<Rep | null> {
  const { data } = await db().from("reps").select("*").eq("sfdc_user_id", sfdcUserId).maybeSingle();
  return (data as Rep | null) ?? null;
}

export async function updateAlert(id: number, fields: Record<string, unknown>) {
  const { error } = await db()
    .from("spike_alerts")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function getAlertStatus(id: number): Promise<string | null> {
  const { data } = await db().from("spike_alerts").select("status").eq("id", id).maybeSingle();
  return data?.status ?? null;
}
