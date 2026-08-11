import type { Request, Response } from 'express';
import { gql, getMemberRole, isAtLeast } from './_lib/db';
import { startRun } from './_lib/engine';
import { requireInternalCaller } from './_lib/internal';

/**
 * Hasura Action handler for `triggerWorkflowRun(workflow_id: uuid!)`.
 *
 * Hasura forwards the caller's JWT-derived session variables in
 * `request_query.session_variables` (because `forward_client_headers: true`
 * + the action is called with the user's own token, not the admin secret).
 *
 * Steps, in order (each one maps directly to a spec requirement):
 *  1. Verify caller is owner/editor in the workflow's org      (role gate)
 *  2. Check the org's quota isn't exhausted                    (quota gate)
 *  3. Delegate to startRun() to create the run and kick off execution
 *  4. Return { workflow_run_id, status } to the client
 */
export default async function handler(req: Request, res: Response) {
  if (!requireInternalCaller(req, res)) return;
  const sessionVars = req.body.session_variables || {};
  const userId = sessionVars['x-hasura-user-id'];
  const { workflow_id } = req.body.input;

  if (!userId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  // look up the workflow to find its org
  const wfData = await gql<{ workflows_by_pk: { id: string; org_id: string; is_active: boolean } | null }>(
    `query ($id: uuid!) { workflows_by_pk(id: $id) { id org_id is_active } }`,
    { id: workflow_id }
  );
  const workflow = wfData.workflows_by_pk;
  if (!workflow) {
    return res.status(404).json({ message: 'Workflow not found' });
  }

  // 1) role gate — owner/editor only. This re-checks even though Hasura
  // permissions already scoped the workflows_by_pk read above, because a
  // viewer CAN read a workflow (read-only access) but must NOT be able to
  // trigger it — that distinction lives here, not in a select permission.
  const role = await getMemberRole(userId, workflow.org_id);
  if (!isAtLeast(role, 'editor')) {
    return res.status(403).json({ message: 'Only an owner or editor can trigger a run' });
  }

  if (!workflow.is_active) {
    return res.status(400).json({ message: 'Workflow is not active' });
  }

  // 2) quota gate
  const orgData = await gql<{ organizations_by_pk: { quota_calls_used: number; quota_calls_allowed: number } }>(
    `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_calls_used quota_calls_allowed } }`,
    { id: workflow.org_id }
  );
  const org = orgData.organizations_by_pk;
  if (org.quota_calls_used >= org.quota_calls_allowed) {
    return res.status(429).json({ message: 'Organization quota exhausted for this period' });
  }

  // 3) create the run and kick off execution. startRun creates the
  // workflow_run + step_run rows and returns immediately — actual step
  // execution happens in the background (fire-and-forget inside
  // engine.ts) so this handler doesn't block on external LLM/HTTP calls
  // that could exceed the platform's function timeout.
  const runId = await startRun({
    workflowId: workflow.id,
    orgId: workflow.org_id,
    triggeredBy: userId,
    triggerType: 'manual',
  });

  return res.json({ workflow_run_id: runId, status: 'running' });
}