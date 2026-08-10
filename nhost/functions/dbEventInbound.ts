import type { Request, Response } from 'express';
import { gql } from './_lib/db';
import { startRun } from './_lib/engine';

/**
 * Fired by the Hasura Event Trigger on `leads` INSERT (see
 * metadata/databases/default/tables/public_leads.yaml). Looks up any
 * workflow_triggers of type `db_event` watching the `leads` table for this
 * org, and starts a run for each — this is the "row change in a watched
 * table auto-starts a run" trigger type.
 */
export default async function handler(req: Request, res: Response) {
  const event = req.body.event;
  const table = req.body.table?.name;
  const op = event?.op;
  const row = event?.data?.new;

  if (!row) return res.json({ started_runs: [] });

  const data = await gql<{
    workflow_triggers: { id: string; workflow_id: string; config: any; workflow: { org_id: string; is_active: boolean } }[];
  }>(
    `query {
      workflow_triggers(where: { type: { _eq: db_event }, is_enabled: { _eq: true } }) {
        id workflow_id config
        workflow { org_id is_active }
      }
    }`
  );

  const matching = data.workflow_triggers.filter(
    (t) =>
      t.workflow.is_active &&
      t.config?.table === table &&
      (t.config?.op ?? 'INSERT') === op &&
      t.workflow.org_id === row.org_id // scope to the SAME org the row belongs to
  );

  const started: string[] = [];
  for (const t of matching) {
    const org = await gql<{ organizations_by_pk: { quota_calls_used: number; quota_calls_allowed: number } }>(
      `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_calls_used quota_calls_allowed } }`,
      { id: t.workflow.org_id }
    );
    if (org.organizations_by_pk.quota_calls_used >= org.organizations_by_pk.quota_calls_allowed) continue;

    const runId = await startRun({
      workflowId: t.workflow_id,
      orgId: t.workflow.org_id,
      triggeredBy: null,
      triggerType: 'db_event',
      seedContext: { trigger_row: row },
    });
    started.push(runId);
  }

  return res.json({ started_runs: started });
}
