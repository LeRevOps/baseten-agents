/**
 * Seeds Supabase with 60 days of fake inference usage for 20 accounts,
 * plants three spikes with different shapes, and writes CSVs for Salesforce import.
 *
 *   org_003  Acme Robotics      EXPANSION  new 70B deployment ramping since day -12
 *   org_007  Lumen Health AI    RISK       one-day 12x jump three days ago
 *   org_011  Northbeam Search   COMMIT     steady growth to ~87% of monthly commit
 *
 * Run: npm run seed
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { db } from "../lib/db";

const COMPANIES = [
  "Pinecrest Analytics", "Halcyon Labs", "Acme Robotics", "Vantage Legal AI", "Orbit Commerce",
  "Tidewater Bio", "Lumen Health AI", "Granite Fintech", "Cobalt Studios", "Meridian Voice",
  "Northbeam Search", "Fernwood Edu", "Quarry Logistics", "Saltmarsh Security", "Bluebird Support",
  "Kestrel Insurance", "Driftwood Media", "Aster Genomics", "Summit Retail", "Ironleaf Gaming",
];
const MODELS = ["llama-3.1-8b", "mistral-7b", "whisper-large-v3", "sdxl", "qwen-2.5-32b"];
const DAY = 86_400_000;

// Deterministic randomness so the demo data is identical every time you seed
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const noise = (base: number, pct = 0.12) => Math.round(base * (1 + (rand() * 2 - 1) * pct));
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);

type Row = { account_id: string; usage_date: string; deployment_id: string; model_name: string; gpu_minutes: number; requests: number };

function generate(): { usage: Row[]; contracts: { account_id: string; monthly_commit_gpu_minutes: number; contract_end: string }[] } {
  const usage: Row[] = [];
  const contracts = [];

  for (let i = 0; i < COMPANIES.length; i++) {
    const org = `org_${String(i + 1).padStart(3, "0")}`;
    const base = 300 + Math.round(rand() * 2200);
    const model = MODELS[i % MODELS.length];
    const push = (daysAgo: number, dep: string, m: string, mins: number) =>
      usage.push({ account_id: org, usage_date: iso(daysAgo), deployment_id: dep, model_name: m, gpu_minutes: Math.max(0, mins), requests: Math.max(0, mins * 37) });

    for (let d = 59; d >= 0; d--) {
      if (org === "org_003") {
        push(d, `${org}-dep-a`, "llama-3.1-8b", noise(1200));
        if (d <= 12) push(d, `${org}-dep-b`, "llama-3.3-70b", noise(200 + (12 - d) * 150, 0.08)); // the ramp
      } else if (org === "org_007") {
        push(d, `${org}-dep-a`, "whisper-large-v3", d === 3 ? 12000 : noise(1000)); // the one-day jump
      } else if (org === "org_011") {
        push(d, `${org}-dep-a`, "qwen-2.5-32b", noise(d < 14 ? 3200 : 2000, 0.06)); // the step-up
      } else {
        push(d, `${org}-dep-a`, model, noise(base));
      }
    }

    const monthlyCommit = org === "org_011" ? 110_000 : Math.round(base * 30 * (1.4 + rand()));
    contracts.push({ account_id: org, monthly_commit_gpu_minutes: monthlyCommit, contract_end: iso(-(90 + Math.round(rand() * 200))) });
  }
  return { usage, contracts };
}

function writeSalesforceCsvs() {
  mkdirSync("salesforce", { recursive: true });
  const accounts = ["Account Name,Baseten Org Id,Industry"];
  const contacts = ["First Name,Last Name,Title,Email,Account Name"];
  const first = ["Priya", "Marcus", "Elena", "Dev", "Hannah", "Tomas", "Aisha", "Ken", "Sofia", "Ravi"];
  const last = ["Shah", "Okafor", "Ruiz", "Patel", "Kim", "Novak", "Bello", "Ito", "Marin", "Iyer"];

  COMPANIES.forEach((name, i) => {
    const org = `org_${String(i + 1).padStart(3, "0")}`;
    accounts.push(`${name},${org},Technology`);
    const domain = name.toLowerCase().replace(/[^a-z]/g, "") + ".example.com";
    const tf = org === "org_003" ? "Priya" : first[i % 10];
    const tl = org === "org_003" ? "Shah" : last[(i + 3) % 10];
    const techTitle = org === "org_003" ? "Head of ML Platform" : ["Staff ML Engineer", "VP Engineering", "Platform Lead", "CTO"][i % 4];
    contacts.push(`${tf},${tl},${techTitle},${tf.toLowerCase()}@${domain},${name}`);
    contacts.push(`${first[(i + 5) % 10]},${last[i % 10]},Procurement Manager,${first[(i + 5) % 10].toLowerCase()}@${domain},${name}`);
  });

  writeFileSync("salesforce/accounts.csv", accounts.join("\n") + "\n");
  writeFileSync("salesforce/contacts.csv", contacts.join("\n") + "\n");
}

async function main() {
  const client = db();
  const { usage, contracts } = generate();

  console.log("Clearing old demo data...");
  await client.from("spike_alerts").delete().neq("id", 0);
  await client.from("product_usage_daily").delete().neq("account_id", "");
  await client.from("contracts").delete().neq("account_id", "");

  console.log(`Inserting ${usage.length} usage rows...`);
  for (let i = 0; i < usage.length; i += 500) {
    const { error } = await client.from("product_usage_daily").insert(usage.slice(i, i + 500));
    if (error) throw error;
  }
  const { error: cErr } = await client.from("contracts").insert(contracts);
  if (cErr) throw cErr;

  if (process.env.REP_SFDC_USER_ID && process.env.REP_SLACK_USER_ID) {
    const { error } = await client.from("reps").upsert({
      sfdc_user_id: process.env.REP_SFDC_USER_ID,
      name: process.env.REP_NAME ?? "Demo Rep",
      slack_user_id: process.env.REP_SLACK_USER_ID,
    });
    if (error) throw error;
    console.log("Rep mapping saved.");
  } else {
    console.warn("REP_SFDC_USER_ID / REP_SLACK_USER_ID not set: every alert will route to RevOps.");
  }

  writeSalesforceCsvs();
  const { data: spikes } = await client.rpc("detect_spikes", { lift_threshold: 1.5, min_abs_increase: 500 });
  console.log("Spikes detected after seeding (expect org_003, org_007, org_011):");
  console.table(spikes);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
