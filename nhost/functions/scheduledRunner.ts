import type { Request, Response } from 'express';
import { gql } from './_lib/db';
import { startRun } from './_lib/engine';

// Minimal cron matcher — supports the standard 5-field syntax well enough
// for demo schedules like "*/5 * * * *". Swap for `cron-parser` in a real
// deployment; kept dependency-free here for portability.
function cronDue(expr: string, now: Date): boolean {
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/);
  const match = (field: string, value: number) =>
    field === '*' || field.split(',').some((f) => {
      if (f.includes('/')) {
        const [, step] = f.split('/');
        return value % Number(step) === 0;
      }
      return Number(f) === value;
    });
  return (
    match(min, now.getMinutes()) &&
    match(hour, now.getHours()) &&
    match(dom, now.getDate()) &&
    match(mon, now.getMonth() + 1) &&
    match(dow, now.getDay())
  );
}

export default async function handler(_req: Request, res: Response) {
  const now = new Date();

  const data = await gql<{
    workflow_triggers: { id: string; workflow_id: string; config: any; workflow: { org_id: string; is_active: boolean } }[];
  }>(
    `query {
      workflow_triggers(where: { type: { _eq: scheduled }, is_enabled: { _eq: true } }) {
        id workflow_id config
        workflow { org_id is_active }
      }
    }`
  );

  const due = data.workflow_triggers.filter(
    (t) => t.workflow.is_active && t.config?.cron && cronDue(t.config.cron, now)
  );

  const started: string[] = [];
  for (const t of due) {
    // system-triggered: no user in the loop, no role check needed (the
    // trigger itself was created by an owner, gated at insert time), but
    // quota is still enforced so a scheduled trigger can't run past it
    const org = await gql<{ organizations_by_pk: { quota_calls_used: number; quota_calls_allowed: number } }>(
      `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_calls_used quota_calls_allowed } }`,
      { id: t.workflow.org_id }
    );
    if (org.organizations_by_pk.quota_calls_used >= org.organizations_by_pk.quota_calls_allowed) continue;

    const runId = await startRun({
      workflowId: t.workflow_id,
      orgId: t.workflow.org_id,
      triggeredBy: null,
      triggerType: 'scheduled',
    });
    started.push(runId);
  }

  return res.json({ started_runs: started });
}
