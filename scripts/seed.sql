-- Two-org demo data with real user ids.

-- Org A
insert into organizations (id, name, quota_calls_allowed) values
  ('00000000-0000-0000-0000-00000000000a', 'Org A — Acme', 1000);

-- Org B
insert into organizations (id, name, quota_calls_allowed) values
  ('00000000-0000-0000-0000-00000000000b', 'Org B — Globex', 1000);

-- membership
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', '7240ee3d-189c-4ee0-8316-0abb8cd81020', 'owner'),
  ('00000000-0000-0000-0000-00000000000b', '7fc49fc0-1133-4d74-897f-47e515b0e2a3', 'owner');

-- sample Org A workflow: llm_call -> conditional_branch -> approval_gate
insert into workflows (id, org_id, name, description, created_by) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a',
   'Lead triage', 'Summarize a lead, branch on sentiment, gate on approval',
   '7240ee3d-189c-4ee0-8316-0abb8cd81020');

insert into workflow_steps (workflow_id, step_order, type, name, config) values
  ('10000000-0000-0000-0000-000000000001', 0, 'llm_call', 'Summarize lead',
   '{"prompt": "Classify this lead as positive or negative: {{step_trigger_row}}"}'),
  ('10000000-0000-0000-0000-000000000001', 1, 'conditional_branch', 'Branch on sentiment',
   '{"condition": "output.result contains ''positive''", "on_true_skip_to": 2, "on_false_skip_to": 3}'),
  ('10000000-0000-0000-0000-000000000001', 2, 'http_request', 'Notify sales API',
   '{"url": "https://httpbin.org/post", "method": "POST", "body": {"lead": "hot"}}'),
  ('10000000-0000-0000-0000-000000000001', 3, 'approval_gate', 'Manager review',
   '{"required_role": "editor"}');

insert into workflow_triggers (id, workflow_id, type, config) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'manual', '{}'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'webhook',
   '{"secret": "demo-webhook-secret"}');