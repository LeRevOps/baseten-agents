import type { SfAccount, SfContact } from "./types";

const API = "v62.0";

// OAuth 2.0 Client Credentials flow (server-to-server, no user login).
// Set up in Salesforce: Setup > External Client App Manager > New, enable OAuth,
// enable Client Credentials Flow, and pick a "Run As" user.
async function getToken(): Promise<{ token: string; instanceUrl: string }> {
  const res = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SF_CLIENT_ID!,
      client_secret: process.env.SF_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) throw new Error(`Salesforce auth failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { token: json.access_token, instanceUrl: json.instance_url };
}

export async function soql<T>(query: string): Promise<T[]> {
  const { token, instanceUrl } = await getToken();
  const res = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429 || res.status >= 500) {
    // Transient: let the workflow step retry
    throw Object.assign(new Error(`Salesforce ${res.status}`), { retryable: true });
  }
  if (!res.ok) throw new Error(`SOQL failed: ${res.status} ${await res.text()}`);
  return (await res.json()).records as T[];
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Join product data to CRM via the external ID field. Returns null if no match. */
export async function getAccountByOrgId(orgId: string): Promise<SfAccount | null> {
  const rows = await soql<Record<string, any>>(
    `SELECT Id, Name, OwnerId, Industry,
       (SELECT Name, StageName, Amount FROM Opportunities WHERE IsClosed = false)
     FROM Account WHERE Baseten_Org_Id__c = '${esc(orgId)}' LIMIT 1`
  );
  const a = rows[0];
  if (!a) return null;
  return {
    Id: a.Id,
    Name: a.Name,
    OwnerId: a.OwnerId,
    Industry: a.Industry ?? null,
    openOpps: (a.Opportunities?.records ?? []).map((o: any) => ({ Name: o.Name, StageName: o.StageName, Amount: o.Amount })),
  };
}

// Deterministic contact selection: auditable, no AI needed.
const TECH_TITLES = /(ml|machine learning|ai|platform|infra|engineer|cto|vp eng|head of eng)/i;

export async function pickContact(accountId: string): Promise<SfContact | null> {
  const rows = await soql<Record<string, any>>(
    `SELECT Id, Name, Title, Email, LastActivityDate
     FROM Contact WHERE AccountId = '${esc(accountId)}' AND Email != null
     ORDER BY LastActivityDate DESC NULLS LAST LIMIT 50`
  );
  if (rows.length === 0) return null;
  const technical = rows.find((c) => c.Title && TECH_TITLES.test(c.Title));
  const c = technical ?? rows[0];
  return { Id: c.Id, Name: c.Name, Title: c.Title ?? null, Email: c.Email ?? null, enrichmentStatus: "skipped" };
}

export function recordUrl(id: string) {
  return `${process.env.SF_LOGIN_URL?.replace(".my.salesforce.com", ".lightning.force.com")}/lightning/r/${id}/view`;
}
