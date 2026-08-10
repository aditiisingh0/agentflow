-- ============================================================
-- AgentFlow: AI Agent Workflow Builder — Core Schema
-- ============================================================
create extension if not exists pgcrypto;

-- ---------- ENUMS ----------
-- A previous interrupted deployment can leave this first enum behind before
-- the migration is recorded. Keeping its creation idempotent makes retries
-- safe on a freshly provisioned cloud database.
do $$ begin
  create type org_role as enum ('owner', 'editor', 'viewer');
exception
  when duplicate_object then null;
end $$;
create type step_type as enum ('llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate');
create type trigger_type as enum ('manual', 'webhook', 'scheduled', 'db_event');
create type run_status as enum ('pending', 'running', 'paused', 'succeeded', 'failed', 'cancelled');
create type step_run_status as enum ('pending', 'running', 'succeeded', 'failed', 'paused', 'skipped');

-- ---------- ORGANIZATIONS ----------
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  quota_calls_allowed int not null default 1000,
  quota_calls_used int not null default 0,
  quota_period_start timestamptz not null default date_trunc('month', now()),
  created_at timestamptz not null default now()
);

-- ---------- ORG MEMBERS ----------
-- links auth.users (nhost's built-in users table) to an org with a role
create table org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role org_role not null default 'viewer',
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index idx_org_members_user on org_members(user_id);
create index idx_org_members_org on org_members(org_id);

-- ---------- WORKFLOWS ----------
create table workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_workflows_org on workflows(org_id);

-- ---------- WORKFLOW STEPS ----------
create table workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  step_order int not null,
  type step_type not null,
  name text not null,
  config jsonb not null default '{}'::jsonb,
  -- config examples:
  --  llm_call: {"prompt": "...", "model": "llama-3.1-8b-instant"}
  --  http_request: {"url": "...", "method": "POST", "body": {...}}
  --  db_write: {"table": "..."}
  --  notify: {"channel": "slack"|"email", "target": "..."}
  --  conditional_branch: {"condition": "output.contains('yes')", "on_true_skip_to": <step_order>, "on_false_skip_to": <step_order>}
  --  approval_gate: {"required_role": "owner"}
  created_at timestamptz not null default now(),
  unique (workflow_id, step_order)
);
create index idx_workflow_steps_workflow on workflow_steps(workflow_id);

-- ---------- WORKFLOW TRIGGERS ----------
create table workflow_triggers (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  type trigger_type not null,
  config jsonb not null default '{}'::jsonb,
  -- webhook: {"secret": "..."}  (secret checked in the Action handler)
  -- scheduled: {"cron": "*/5 * * * *"}
  -- db_event: {"table": "leads", "op": "INSERT"}
  is_enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_workflow_triggers_workflow on workflow_triggers(workflow_id);

-- ---------- WORKFLOW RUNS ----------
create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade, -- denormalized for fast/simple permission checks
  status run_status not null default 'pending',
  triggered_by uuid references auth.users(id), -- null for webhook/scheduled/db_event
  trigger_type trigger_type not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  current_step_order int not null default 0,
  context jsonb not null default '{}'::jsonb -- accumulates step outputs, keyed by step_order
);
create index idx_workflow_runs_workflow on workflow_runs(workflow_id);
create index idx_workflow_runs_org on workflow_runs(org_id);

-- ---------- STEP RUNS ----------
create table step_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id) on delete cascade,
  workflow_step_id uuid not null references workflow_steps(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade, -- denormalized for permission checks
  step_order int not null,
  type step_type not null,
  status step_run_status not null default 'pending',
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error text,
  attempt_count int not null default 0,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz
);
create index idx_step_runs_run on step_runs(workflow_run_id);
create index idx_step_runs_org on step_runs(org_id);

-- ---------- LEADS ----------
-- demo external-facing table used to exercise the "db_event" trigger type:
-- a row inserted here (e.g. by a form submission / CRM sync) can auto-start
-- a workflow run for the org that owns it, via a Hasura Event Trigger.
create table leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_leads_org on leads(org_id);

-- ---------- helper view: org usage this month ----------
create view org_usage_this_month as
select
  o.id as org_id,
  o.quota_calls_allowed,
  o.quota_calls_used,
  count(wr.id) filter (where wr.started_at >= date_trunc('month', now())) as runs_this_month,
  avg(extract(epoch from (wr.finished_at - wr.started_at)))
    filter (where wr.finished_at is not null and wr.started_at >= date_trunc('month', now())) as avg_run_duration_seconds
from organizations o
left join workflow_runs wr on wr.org_id = o.id
group by o.id, o.quota_calls_allowed, o.quota_calls_used;

-- ---------- updated_at trigger for workflows ----------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_workflows_updated_at
before update on workflows
for each row execute function set_updated_at();
