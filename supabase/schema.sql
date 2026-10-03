-- Run this in the Supabase SQL editor.

-- 1. Product usage (stands in for the warehouse)
create table if not exists product_usage_daily (
  account_id    text not null,          -- Baseten org id; matches Salesforce Account.Baseten_Org_Id__c
  usage_date    date not null,
  deployment_id text not null,
  model_name    text not null,
  gpu_minutes   numeric not null,
  requests      bigint not null,
  primary key (account_id, usage_date, deployment_id)
);

-- 2. Contract commits (in real life this lives in billing or Salesforce)
create table if not exists contracts (
  account_id                 text primary key,
  monthly_commit_gpu_minutes numeric not null,
  contract_end               date not null
);

-- 3. Reps: maps a Salesforce owner to a Slack user
create table if not exists reps (
  sfdc_user_id     text primary key,
  name             text not null,
  slack_user_id    text not null,
  manager_slack_id text
);

-- 4. Alert ledger: how we guarantee no repeats, and how we measure adoption
create table if not exists spike_alerts (
  id          bigint generated always as identity primary key,
  account_id  text not null,
  window_end  date not null,
  lift        numeric not null,
  spike_type  text,
  confidence  numeric,
  status      text not null default 'claimed',  -- claimed | sent_to_rep | routed_to_revops | marked_sent | not_useful | snoozed | skipped_no_owner
  slack_channel text,
  slack_ts    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (account_id, window_end)                -- same-day reruns can never double-alert
);

-- Spike detection: last 14 days vs the prior 28, with a relative AND absolute bar
create or replace function detect_spikes(
  lift_threshold numeric default 1.5,
  min_abs_increase numeric default 500
)
returns table (account_id text, recent_avg numeric, baseline_avg numeric, lift numeric)
language sql stable as $$
  with daily as (
    select account_id, usage_date, sum(gpu_minutes) as gpu_min
    from product_usage_daily
    where usage_date >= current_date - 42
    group by 1, 2
  ),
  w as (
    select account_id,
      avg(gpu_min) filter (where usage_date >= current_date - 14) as recent_avg,
      avg(gpu_min) filter (where usage_date <  current_date - 14) as baseline_avg
    from daily
    group by 1
  )
  select account_id,
         round(recent_avg, 1),
         round(baseline_avg, 1),
         round(recent_avg / nullif(baseline_avg, 0), 2) as lift
  from w
  where recent_avg / nullif(baseline_avg, 0) >= lift_threshold
    and recent_avg - baseline_avg >= min_abs_increase
  order by lift desc;
$$;
