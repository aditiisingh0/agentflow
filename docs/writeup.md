# Write-up

## Schema reasoning

The spine is `organizations → org_members → workflows → workflow_steps` /
`workflow_triggers`, and `workflows → workflow_runs → step_runs`. Two
choices are worth calling out:

1. **`org_id` is denormalized onto `workflow_runs` and `step_runs`**, not
   just reachable via `workflow_id`. Every permission filter and every
   quota/role check in the Action handlers needs "which org does this row
   belong to," and a live subscription filtered by `workflow_run_id` gets
   hit on every step update — hopping `step_run → workflow_run → workflow →
   organization` on each of those checks is unnecessary joins for
   information that never changes after the row is created. It's the one
   deliberate departure from strict normalization, made for a table that's
   read/written on a hot path.

2. **`workflow_runs.context` is a single JSONB blob, keyed by
   `step_order`**, rather than a separate outputs table. Steps need to
   reference prior outputs (`{{step0.result}}` in a later prompt, or a
   `conditional_branch`'s condition), and passing that around as one
   growing object mirrors how the engine already threads state through
   execution — it's the same shape in Postgres as in memory.

## How the two permission layers are enforced differently

**Layer 1** (org + role scoping) is a pure Hasura row-permission problem:
every table's filter/check expression walks a relationship chain back to
`org_members` and requires `user_id = X-Hasura-User-Id`. Role is checked
where it matters (`role IN (owner, editor)` to write, any role to read),
but membership is checked *unconditionally* on every operation — that's
what makes cross-org access structurally impossible rather than merely
disallowed. There's no code path where a query "forgets" the org filter,
because it's not code, it's a declarative permission Hasura enforces on
every request including ones that guess an ID directly.

**Layer 2** (step-level gating) is the same mechanism with a tighter
condition, expressed as an `_or` inside the same `check`/`filter`
expression: "membership as editor is enough, UNLESS this row's `type` is
one of the sandbox-escaping ones, in which case membership must be
`owner`." It's still declarative and still enforced by Postgres via
Hasura — the difference from layer 1 is only that the condition inspects
a column on the row being written (`type`), not just the caller's
identity.

**The approval-gate clearance is neither** — it's checked in
`approveStep.ts` after the Action receives the call, because resuming a
paused run is a side effect (restarting the execution loop) that a
database permission has no way to trigger. `step_runs` has zero `user`-role
write permissions in Hasura specifically so there's no way to bypass this
check by mutating the row directly.

## Approval-gate pause/resume implementation

When the engine (`engine.ts`, `executeFrom`) reaches a step whose `type`
is `approval_gate`, it marks both that `step_run` and its parent
`workflow_run` as `paused`, then returns without advancing `i`. This makes
the gate explicit in the live subscription and means the approval Action
can reject IDs for ordinary completed steps. No timer, polling loop, or
held connection is involved — the function simply exits.

Resuming is a distinct entry point (`resumeRun` in `engine.ts`, called
from `approveStep.ts`) that re-fetches the run's `current_step_order` and
`context` from Postgres, re-fetches the workflow's steps, and calls
`executeFrom` starting at `current_step_order + 1`. Because all run state
(`context`, `current_step_order`, each `step_run`'s status) is persisted
after every step rather than held in the function's memory, resume works
correctly even if `approveStep` runs as a cold-started serverless
invocation with no relationship to the process that originally paused the
run — which is the normal case for Hasura Actions.
