import type { Request, Response } from 'express';
import { gql } from './_lib/db';
import { startRun } from './_lib/engine';

/**
 * Inbound endpoint for the `webhook` trigger type: POST
 * /webhookTrigger?trigger_id=<uuid> with header `x-webhook-secret` matching the
 * secret stored in workflow_triggers.config at creation time (only an
 * owner could have created a webhook trigger — see the layer-2 Hasura
 * permission on workflow_triggers).
 */
export default async function handler(req: Request, res: Response) {
  // Nhost Cloud Functions use file-based routes, so a dynamic Express route
  // such as `/webhookTrigger/:trigger_id` is not available in production.
  // The local Express server accepts the query form too, which keeps one
  // documented endpoint shape for both environments.
  const triggerId = String(req.query.trigger_id || '');
  const suppliedSecret = req.header('x-webhook-secret');

  const data = await gql<{
    workflow_triggers_by_pk: {
      id: string;
      type: string;
      is_enabled: boolean;
      config: any;
      workflow_id: string;
      workflow: { org_id: string; is_active: boolean };
    } | null;
  }>(
    `query ($id: uuid!) {
      workflow_triggers_by_pk(id: $id) {
        id type is_enabled config workflow_id
        workflow { org_id is_active }
      }
    }`,
    { id: triggerId }
  );
  const trigger = data.workflow_triggers_by_pk;

  if (!trigger || trigger.type !== 'webhook' || !trigger.is_enabled) {
    return res.status(404).json({ message: 'No such webhook trigger' });
  }
  if (trigger.config?.secret && trigger.config.secret !== suppliedSecret) {
    return res.status(401).json({ message: 'Invalid webhook secret' });
  }
  if (!trigger.workflow.is_active) {
    return res.status(400).json({ message: 'Workflow is not active' });
  }

  const org = await gql<{ organizations_by_pk: { quota_calls_used: number; quota_calls_allowed: number } }>(
    `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_calls_used quota_calls_allowed } }`,
    { id: trigger.workflow.org_id }
  );
  if (org.organizations_by_pk.quota_calls_used >= org.organizations_by_pk.quota_calls_allowed) {
    return res.status(429).json({ message: 'Organization quota exhausted' });
  }

  const runId = await startRun({
    workflowId: trigger.workflow_id,
    orgId: trigger.workflow.org_id,
    triggeredBy: null,
    triggerType: 'webhook',
    seedContext: { webhook_payload: req.body },
  });

  return res.json({ workflow_run_id: runId, status: 'started' });
}
