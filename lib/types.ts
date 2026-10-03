export type Spike = {
  account_id: string;
  recent_avg: number;
  baseline_avg: number;
  lift: number;
};

export type DeploymentBreakdown = {
  deployment_id: string;
  model_name: string;
  recent_avg: number;
  baseline_avg: number;
  first_seen: string;
};

export type UsageContext = {
  breakdown: DeploymentBreakdown[];
  maxSingleDay: number;
  maxSingleDayDate: string;
  commitUtilization: number | null; // recent monthly run-rate / monthly commit
  contractEnd: string | null;
};

export type SfAccount = {
  Id: string;
  Name: string;
  OwnerId: string;
  Industry: string | null;
  openOpps: { Name: string; StageName: string; Amount: number | null }[];
};

export type SfContact = {
  Id: string;
  Name: string;
  Title: string | null;
  Email: string | null;
  enrichedTitle?: string | null;
  enrichmentStatus: "enriched" | "not_enriched" | "skipped";
};

export type Rep = {
  sfdc_user_id: string;
  name: string;
  slack_user_id: string;
  manager_slack_id: string | null;
};

export type Draft = {
  spike_type: "expansion" | "risk" | "commit";
  confidence: number;
  rep_summary: string;
  email_subject: string;
  email_body: string;
};
