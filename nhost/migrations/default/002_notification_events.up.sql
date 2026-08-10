create table notification_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workflow_run_id uuid not null references workflow_runs(id) on delete cascade,
  target text not null,
  message text not null,
  status text not null default 'queued' check (status in ('queued', 'delivered', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index idx_notification_events_run on notification_events(workflow_run_id);
