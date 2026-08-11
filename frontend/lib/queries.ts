// The org's workflows with steps, triggers, and most recent run status
export const GET_ORG_WORKFLOWS = `
  query GetOrgWorkflows($orgId: uuid!) {
    workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }) {
      id
      name
      description
      is_active
      workflow_steps(order_by: { step_order: asc }) {
        id step_order type name config
      }
      workflow_triggers {
        id type config is_enabled
      }
      workflow_runs(order_by: { started_at: desc }, limit: 1) {
        id status started_at finished_at
      }
    }
    organizations_by_pk(id: $orgId) {
      id name quota_calls_used quota_calls_allowed
    }
    org_members(where: { org_id: { _eq: $orgId } }) {
      user_id role
    }
  }
`;

// create/edit a workflow with steps and triggers in one shot
export const UPSERT_WORKFLOW = `
  mutation UpsertWorkflow(
    $orgId: uuid!
    $name: String!
    $description: String
    $steps: [workflow_steps_insert_input!]!
    $triggers: [workflow_triggers_insert_input!]!
  ) {
    insert_workflows_one(object: {
      org_id: $orgId
      name: $name
      description: $description
      workflow_steps: { data: $steps }
      workflow_triggers: { data: $triggers }
    }) {
      id
    }
  }
`;

export const GET_WORKFLOW_FOR_EDIT = `
  query WorkflowForEdit($workflowId: uuid!) {
    workflows_by_pk(id: $workflowId) {
      id
      org_id
      name
      description
      is_active
      workflow_steps(order_by: { step_order: asc }) {
        id step_order type name config
      }
      workflow_triggers(order_by: { created_at: asc }) {
        id type config is_enabled
      }
      workflow_runs(where: { status: { _in: [running, paused] } }, limit: 1) {
        id
      }
    }
  }
`;

export const UPDATE_WORKFLOW = `
  mutation UpdateWorkflow($id: uuid!, $changes: workflows_set_input!) {
    update_workflows_by_pk(pk_columns: { id: $id }, _set: $changes) { id }
  }
`;

export const SHIFT_WORKFLOW_STEPS = `
  mutation ShiftWorkflowSteps($workflowId: uuid!) {
    update_workflow_steps(
      where: { workflow_id: { _eq: $workflowId } }
      _inc: { step_order: 10000 }
    ) { affected_rows }
  }
`;

export const UPDATE_WORKFLOW_STEP = `
  mutation UpdateWorkflowStep($id: uuid!, $changes: workflow_steps_set_input!) {
    update_workflow_steps_by_pk(pk_columns: { id: $id }, _set: $changes) { id }
  }
`;

export const INSERT_WORKFLOW_STEPS = `
  mutation InsertWorkflowSteps($steps: [workflow_steps_insert_input!]!) {
    insert_workflow_steps(objects: $steps) { returning { id step_order } }
  }
`;

export const UPDATE_WORKFLOW_TRIGGER = `
  mutation UpdateWorkflowTrigger($id: uuid!, $changes: workflow_triggers_set_input!) {
    update_workflow_triggers_by_pk(pk_columns: { id: $id }, _set: $changes) { id }
  }
`;

export const INSERT_WORKFLOW_TRIGGERS = `
  mutation InsertWorkflowTriggers($triggers: [workflow_triggers_insert_input!]!) {
    insert_workflow_triggers(objects: $triggers) { returning { id } }
  }
`;

export const DELETE_WORKFLOW_TRIGGERS = `
  mutation DeleteWorkflowTriggers($ids: [uuid!]!) {
    delete_workflow_triggers(where: { id: { _in: $ids } }) { affected_rows }
  }
`;

export const TRIGGER_WORKFLOW_RUN = `
  mutation TriggerRun($workflowId: uuid!) {
    triggerWorkflowRun(workflow_id: $workflowId) {
      workflow_run_id
      status
    }
  }
`;

export const APPROVE_STEP = `
  mutation Approve($stepRunId: uuid!, $approve: Boolean!) {
    approveStep(step_run_id: $stepRunId, approve: $approve) {
      step_run_id
      status
    }
  }
`;

// RLS returns null for a run outside the signed-in user's organization. The
// run page uses this before opening its live subscription, so a guessed URL
// produces a clean access-denied screen instead of a transport error.
export const GET_WORKFLOW_RUN_ACCESS = `
  query WorkflowRunAccess($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id
    }
  }
`;

// live per-step progress for a single run, including the paused state
export const SUBSCRIBE_STEP_RUNS = `
  subscription StepRuns($runId: uuid!) {
    step_runs(where: { workflow_run_id: { _eq: $runId } }, order_by: { step_order: asc }) {
      id
      step_order
      type
      status
      output
      error
      attempt_count
      approved_by
      approved_at
      started_at
      finished_at
      workflow_run {
        status
        current_step_order
      }
    }
  }
`;
