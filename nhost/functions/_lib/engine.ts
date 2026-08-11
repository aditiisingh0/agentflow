import { gql } from './db';
import { callLLM } from './llm';

type Step = {
  id: string;
  step_order: number;
  type: string;
  name: string;
  config: any;
};

type RunContext = Record<string, any>; // keyed by step_order -> output

const MAX_RETRIES = 2; // "at least one retry on failure"

/**
 * Creates a workflow_run + step_run rows, then drives execution forward
 * until it either finishes or hits a paused approval_gate. Called by
 * triggerWorkflowRun (manual/webhook), scheduledRunner, and dbEventInbound.
 *
 * NOTE: quota + role checks happen in the caller (triggerWorkflowRun.ts)
 * BEFORE this is invoked — this function assumes authorization already
 * passed and just executes.
 */
export async function startRun(opts: {
  workflowId: string;
  orgId: string;
  triggeredBy: string | null;
  triggerType: 'manual' | 'webhook' | 'scheduled' | 'db_event';
  seedContext?: RunContext;
}) {
  const { workflowId, orgId, triggeredBy, triggerType, seedContext = {} } = opts;

  const stepsData = await gql<{ workflow_steps: Step[] }>(
    `query ($wid: uuid!) {
      workflow_steps(where: { workflow_id: { _eq: $wid } }, order_by: { step_order: asc }) {
        id step_order type name config
      }
    }`,
    { wid: workflowId }
  );
  const steps = stepsData.workflow_steps;

  const runData = await gql<{ insert_workflow_runs_one: { id: string } }>(
    `mutation ($wid: uuid!, $orgId: uuid!, $by: uuid, $tt: trigger_type!, $ctx: jsonb!) {
      insert_workflow_runs_one(object: {
        workflow_id: $wid, org_id: $orgId, triggered_by: $by,
        trigger_type: $tt, status: running, context: $ctx
      }) { id }
    }`,
    { wid: workflowId, orgId, by: triggeredBy, tt: triggerType, ctx: seedContext }
  );
  const runId = runData.insert_workflow_runs_one.id;

  // pre-create step_run rows for every step (status: pending) so the
  // subscription has something to render immediately
  await gql(
    `mutation ($objects: [step_runs_insert_input!]!) {
      insert_step_runs(objects: $objects) { affected_rows }
    }`,
    {
      objects: steps.map((s) => ({
        workflow_run_id: runId,
        workflow_step_id: s.id,
        org_id: orgId,
        step_order: s.step_order,
        type: s.type,
        status: 'pending',
      })),
    }
  );

  await executeFrom(runId, orgId, steps, 0, seedContext);
  return runId;
}

/** Resumes a paused run after an approval_gate is cleared. */
export async function resumeRun(runId: string, orgId: string) {
  const runData = await gql<{ workflow_runs_by_pk: { workflow_id: string; current_step_order: number; context: RunContext } }>(
    `query ($id: uuid!) {
      workflow_runs_by_pk(id: $id) { workflow_id current_step_order context }
    }`,
    { id: runId }
  );
  const run = runData.workflow_runs_by_pk;

  const stepsData = await gql<{ workflow_steps: Step[] }>(
    `query ($wid: uuid!) {
      workflow_steps(where: { workflow_id: { _eq: $wid } }, order_by: { step_order: asc }) {
        id step_order type name config
      }
    }`,
    { wid: run.workflow_id }
  );

  await gql(
    `mutation ($id: uuid!) { update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: running}) { id } }`,
    { id: runId }
  );

  // resume from the NEXT step after the approval_gate
  await executeFrom(runId, orgId, stepsData.workflow_steps, run.current_step_order + 1, run.context);
}

async function executeFrom(runId: string, orgId: string, steps: Step[], startIndex: number, context: RunContext) {
  let i = startIndex;

  while (i < steps.length) {
    const step = steps[i];
    // NOTE: attempt_count is now incremented inside runStepWithRetry, once
    // per actual attempt (including retries) — not once per step here.
    // This just marks the step as running; see runStepWithRetry below.
    await setStepRunStatus(runId, step.id, 'running');

    let output: any;
    let error: string | null = null;

    try {
      output = await runStepWithRetry(step, context, orgId, runId);
    } catch (e: any) {
      error = e.message || String(e);
    }

    if (error) {
      await setStepRunStatus(runId, step.id, 'failed', { error });
      await gql(
        `mutation ($id: uuid!, $order: Int!) {
          update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: failed, finished_at: "now()", current_step_order: $order}) { id }
        }`,
        { id: runId, order: step.step_order }
      );
      return;
    }

    context[step.step_order] = output;
    await setStepRunStatus(runId, step.id, 'succeeded', { output });
    await gql(
      `mutation ($id: uuid!, $order: Int!, $ctx: jsonb!) {
        update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {current_step_order: $order, context: $ctx}) { id }
      }`,
      { id: runId, order: step.step_order, ctx: context }
    );

    // approval_gate: pause here and stop the loop; a later approveStep call resumes
    if (step.type === 'approval_gate') {
      // The gate itself is now visibly paused as well as the parent run.
      // This makes the live subscription unambiguous and prevents a normal
      // completed step from being mistaken for an approval target.
      await setStepRunStatus(runId, step.id, 'paused');
      await gql(
        `mutation ($id: uuid!) { update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: paused}) { id } }`,
        { id: runId }
      );
      return;
    }

    // conditional_branch: jump to the configured step_order instead of i+1
    if (step.type === 'conditional_branch') {
      // `runStep` returns a wrapper describing the prior step for this
      // branch. Evaluate the actual prior output, otherwise expressions such
      // as `output.result contains 'positive'` always see an empty result.
      const cond = evalCondition(step.config, context[step.step_order - 1]);
      const target = cond ? step.config.on_true_skip_to : step.config.on_false_skip_to;
      if (typeof target === 'number') {
        const targetIndex = steps.findIndex((s) => s.step_order === target);
        i = targetIndex >= 0 ? targetIndex : i + 1;
        continue;
      }
    }

    i += 1;
  }

  // reached the end without pausing or failing
  await gql(
    `mutation ($id: uuid!, $orgId: uuid!) {
      update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: succeeded, finished_at: "now()"}) { id }
      update_organizations_by_pk(pk_columns: {id: $orgId}, _inc: {quota_calls_used: 1}) { id }
    }`,
    { id: runId, orgId }
  );
}

function evalCondition(config: any, lastOutput: any): boolean {
  // config.condition is a tiny DSL: "output.field == 'value'" or "output.field contains 'sub'"
  // kept intentionally simple/sandboxed — no eval() of arbitrary JS.
  try {
    const cond = config.condition || '';
    const m = cond.match(/output\.(\w+)\s*(==|contains)\s*'([^']*)'/);
    if (!m) return Boolean(lastOutput?.result);
    const [, field, op, value] = m;
    const fieldVal = String(lastOutput?.[field] ?? '');
    return op === '==' ? fieldVal === value : fieldVal.includes(value);
  } catch {
    return false;
  }
}

async function runStepWithRetry(step: Step, context: RunContext, orgId: string, runId: string): Promise<any> {
  let lastErr: any;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Increment attempt_count on EVERY attempt (including the first), so
    // a step that fails twice and succeeds on the 3rd try ends with
    // attempt_count = 3, and the UI's "retried {attempt_count - 1}×" shows
    // "retried 2×" — matching what actually happened, instead of always
    // showing 1 regardless of how many retries occurred.
    await setStepRunStatus(runId, step.id, 'running', { attempt_count_incr: true });
    try {
      return await runStep(step, context, orgId, runId);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function runStep(step: Step, context: RunContext, orgId: string, runId: string): Promise<any> {
  switch (step.type) {
    case 'llm_call': {
      const prompt = interpolate(step.config.prompt || '', context);
      const text = await callLLM(prompt, step.config.model);
      return { result: text };
    }
    case 'http_request': {
      const res = await fetch(step.config.url, {
        method: step.config.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(step.config.headers || {}) },
        body: step.config.body ? JSON.stringify(interpolateObj(step.config.body, context)) : undefined,
      });
      if (!res.ok) throw new Error(`http_request failed: ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }
    case 'db_write': {
      // writes the previous step's output into `leads.payload` as a demo sink
      const data = await gql<{ insert_leads_one: { id: string } }>(
        `mutation ($orgId: uuid!, $payload: jsonb!) {
          insert_leads_one(object: { org_id: $orgId, email: "workflow@internal", payload: $payload }) { id }
        }`,
        // Never trust an author-controlled config value for tenancy. The
        // execution engine owns the run's org ID, so a workflow in Org A
        // cannot be configured to write into Org B.
        { orgId, payload: context }
      );
      return { written_id: data.insert_leads_one.id };
    }
    case 'notify': {
      // Persist the delivery request. Hasura's notification_events INSERT
      // Event Trigger delivers it asynchronously, so the workflow engine
      // stays transactional and the side effect is independently retried.
      const event = await gql<{ insert_notification_events_one: { id: string } }>(
        `mutation ($orgId: uuid!, $runId: uuid!, $target: String!, $message: String!) {
          insert_notification_events_one(object: {
            org_id: $orgId, workflow_run_id: $runId, target: $target, message: $message
          }) { id }
        }`,
        {
          orgId,
          runId,
          target: step.config.target || '',
          message: interpolate(step.config.message || 'Workflow notification', context),
        }
      );
      return { notification_event_id: event.insert_notification_events_one.id, queued: true };
    }
    case 'conditional_branch': {
      // evaluated against the PREVIOUS step's output, passed in as context
      const prevOrder = step.step_order - 1;
      return { branched_on: context[prevOrder] ?? null };
    }
    case 'approval_gate': {
      return { awaiting_approval: true };
    }
    default:
      throw new Error(`unknown step type: ${step.type}`);
  }
}

function interpolate(template: string, context: RunContext): string {
  return template.replace(/\{\{step(\d+)\.(\w+)\}\}/g, (_m, order, field) => {
    return String(context[Number(order)]?.[field] ?? '');
  });
}
function interpolateObj(obj: any, context: RunContext): any {
  if (typeof obj === 'string') return interpolate(obj, context);
  if (Array.isArray(obj)) return obj.map((v) => interpolateObj(v, context));
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, interpolateObj(v, context)]));
  }
  return obj;
}

async function setStepRunStatus(
  runId: string,
  stepId: string,
  status: string,
  extra: { output?: any; error?: string; attempt_count_incr?: boolean } = {}
) {
  const set: any = { status };
  if (status === 'running') set.started_at = 'now()';
  if (status === 'succeeded' || status === 'failed') set.finished_at = 'now()';
  if (extra.output !== undefined) set.output = extra.output;
  if (extra.error !== undefined) set.error = extra.error;

  if (extra.attempt_count_incr) {
    await gql(
      `mutation ($runId: uuid!, $stepId: uuid!, $set: step_runs_set_input!, $inc: step_runs_inc_input!) {
        update_step_runs(
          where: { workflow_run_id: { _eq: $runId }, workflow_step_id: { _eq: $stepId } },
          _set: $set,
          _inc: $inc
        ) { affected_rows }
      }`,
      { runId, stepId, set, inc: { attempt_count: 1 } }
    );
  } else {
    await gql(
      `mutation ($runId: uuid!, $stepId: uuid!, $set: step_runs_set_input!) {
        update_step_runs(
          where: { workflow_run_id: { _eq: $runId }, workflow_step_id: { _eq: $stepId } },
          _set: $set
        ) { affected_rows }
      }`,
      { runId, stepId, set }
    );
  }
}
