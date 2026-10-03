/**
 * Mini eval: does Claude classify the three planted spike shapes correctly?
 * Needs only ANTHROPIC_API_KEY. Run: npm run eval
 *
 * Principle: test an AI step against cases with known answers before shipping it.
 */
import "dotenv/config";
import { draftOutreach, type DraftInput } from "../lib/claude";

const CASES: { name: string; expected: "expansion" | "risk" | "commit"; input: DraftInput }[] = [
  {
    name: "Acme Robotics: new deployment ramping",
    expected: "expansion",
    input: {
      spike: { account_id: "org_003", recent_avg: 2140, baseline_avg: 1200, lift: 1.78 },
      usage: {
        breakdown: [
          { deployment_id: "dep-b", model_name: "llama-3.3-70b", recent_avg: 940, baseline_avg: 0, first_seen: "2026-09-20" },
          { deployment_id: "dep-a", model_name: "llama-3.1-8b", recent_avg: 1200, baseline_avg: 1200, first_seen: "2026-08-03" },
        ],
        maxSingleDay: 3150, maxSingleDayDate: "2026-10-02", commitUtilization: 0.52, contractEnd: "2027-03-31",
      },
      account: { Name: "Acme Robotics", Industry: "Technology", openOpps: [] },
      contact: { Name: "Priya Shah", Title: "Head of ML Platform" },
    },
  },
  {
    name: "Lumen Health AI: one-day 12x jump",
    expected: "risk",
    input: {
      spike: { account_id: "org_007", recent_avg: 1786, baseline_avg: 1000, lift: 1.79 },
      usage: {
        breakdown: [{ deployment_id: "dep-a", model_name: "whisper-large-v3", recent_avg: 1786, baseline_avg: 1000, first_seen: "2026-08-03" }],
        maxSingleDay: 12000, maxSingleDayDate: "2026-09-29", commitUtilization: 0.6, contractEnd: "2027-06-30",
      },
      account: { Name: "Lumen Health AI", Industry: "Healthcare", openOpps: [] },
      contact: { Name: "Ken Ito", Title: "Staff ML Engineer" },
    },
  },
  {
    name: "Northbeam Search: approaching commit",
    expected: "commit",
    input: {
      spike: { account_id: "org_011", recent_avg: 3200, baseline_avg: 2000, lift: 1.6 },
      usage: {
        breakdown: [{ deployment_id: "dep-a", model_name: "qwen-2.5-32b", recent_avg: 3200, baseline_avg: 2000, first_seen: "2026-08-03" }],
        maxSingleDay: 3390, maxSingleDayDate: "2026-09-25", commitUtilization: 0.87, contractEnd: "2026-12-31",
      },
      account: { Name: "Northbeam Search", Industry: "Technology", openOpps: [] },
      contact: { Name: "Sofia Marin", Title: "VP Engineering" },
    },
  },
];

// The email goes to the customer, so it must not reveal that we watch their usage.
const LEAKS = /\b(usage|spike|burst|surge|traffic|noticed|monitor\w*|gpu)\b|\bwe (saw|see|have seen|'ve seen)\b|\d+(\.\d+)?\s*(%|x\b)|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;
const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function emailLeaks(email: string, input: DraftInput): string[] {
  const hits: string[] = [];
  const m = email.match(LEAKS);
  if (m) hits.push(`"${m[0]}"`);
  for (const dep of input.usage.breakdown) {
    if (flat(email).includes(flat(dep.model_name))) hits.push(`model ${dep.model_name}`);
  }
  return hits;
}

async function main() {
  const results = [];
  for (const c of CASES) {
    const d = await draftOutreach(c.input);
    const leaks = emailLeaks(`${d.email_subject}\n${d.email_body}`, c.input);
    const labelOk = d.spike_type === c.expected;
    results.push({
      case: c.name,
      expected: c.expected,
      got: d.spike_type,
      confidence: d.confidence,
      email: leaks.length ? `LEAK ${leaks.join(", ")}` : "clean",
      pass: labelOk && leaks.length === 0 ? "PASS" : "FAIL",
    });
    console.log(`\n--- ${c.name} ---\n${d.rep_summary}\nSubject: ${d.email_subject}\n${d.email_body}`);
  }
  console.log();
  console.table(results);
  const passed = results.filter((r) => r.pass === "PASS").length;
  console.log(`${passed}/${results.length} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
