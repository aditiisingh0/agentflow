import type { Request, Response } from 'express';
import { gql, getMemberRole, isAtLeast } from './_lib/db';
import { resumeRun } from './_lib/engine';

/**
 * Hasura Action handler for `approveStep(step_run_id: uuid!, approve: Boolean!)`.
 *
 * This is the "mid-execution decision" the spec calls out explicitly:
 * clearing an approval_gate can't be a plain database UPDATE permission,
 * because whether someone is allowed to approve depends on their role in
 * the SAME org that owns the run — which the Hasura permission system
 * can express for simple filters, but the *resume-the-run* side effect
 * (kicking execution back into the engine) has to happen in code either
 * way, so the role check lives right next to it here.
 */
export default async function handler(req: Request, res: Response) {
  const sessionVars = req.body.session_variables || {};
  const userId = sessionVars['x-hasura-user-id'];
  const { step_run_id, approve } = req.body.input;

  if (!userId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const stepRunData = await gql<{
    step_runs_by_pk: {
      id: string;
      status: string;
      org_id: string;
      workflow_run_id: string;
      workflow_step: { config: any };
    } | null;
  }>(
    `query ($id: uuid!) {
      step_runs_by_pk(id: $id) {
        id status org_id workflow_run_id
        workflow_step { config }
      }
    }`,
    { id: step_run_id }
  );
  const stepRun = stepRunData.step_runs_by_pk;
  if (!stepRun) return res.status(404).json({ message: 'step_run not found' });
  if (stepRun.status !== 'succeeded' && stepRun.status !== 'paused') {
    return res.status(400).json({ message: 'This step is not awaiting approval' });
  }

  const requiredRole = stepRun.workflow_step?.config?.required_role || 'owner';
  const role = await getMemberRole(userId, stepRun.org_id);
  if (!isAtLeast(role, requiredRole === 'owner' ? 'owner' : 'editor')) {
    return res.status(403).json({ message: `Only ${requiredRole === 'owner' ? 'an owner' : 'an owner/editor'} in this org can approve this step` });
  }

  if (!approve) {
    await gql(
      `mutation ($runId: uuid!, $userId: uuid!) {
        update_workflow_runs_by_pk(pk_columns: {id: $runId}, _set: {status: cancelled, finished_at: "now()"}) { id }
      }`,
      { runId: stepRun.workflow_run_id, userId }
    );
    return res.json({ step_run_id, status: 'cancelled' });
  }

  await gql(
    `mutation ($id: uuid!, $userId: uuid!) {
      update_step_runs_by_pk(pk_columns: {id: $id}, _set: {approved_by: $userId, approved_at: "now()"}) { id }
    }`,
    { id: step_run_id, userId }
  );

  await resumeRun(stepRun.workflow_run_id, stepRun.org_id);

  return res.json({ step_run_id, status: 'resumed' });
}
