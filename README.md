# AgentFlow — AI Agent Workflow Builder

A mini n8n for chaining AI agent steps, built on nhost + Hasura + Postgres +
GraphQL, with two independent permission layers and live run tracking.

## Stack

- **Postgres** — schema in `nhost/migrations/default/001_init_schema.up.sql`
- **Hasura** — table tracking, relationships, permissions, Actions, event
  trigger, and cron trigger in `nhost/metadata/`
- **Functions** (Node/Express, TypeScript) — the Action handlers and
  execution engine in `nhost/functions/`
- **Frontend** — Next.js (App Router) + urql (GraphQL over HTTP + WS) in
  `frontend/`, including workflow creation/editing, live run progress, and
  inline sign-in feedback
- **LLM** — Groq's OpenAI-compatible chat completion API for `llm_call`
  steps. Falls back to a disclosed stub (labeled `[STUBBED LLM RESPONSE]`,
  with an artificial 800ms delay) if `GROQ_API_KEY` isn't set.

## Live deployment

- **Frontend:** https://agentflow-six-liard.vercel.app
- **Backend:** Nhost Cloud (subdomain `urxfkigkctgfpkrbpfdv`, region `ap-south-1`)
- Demo credentials:
  - `owner1@agentflow.local` — Org A (Acme) owner
  - `owner2@agentflow.local` — Org B (Globex) owner
  - Password: `YourPassword123!`

## Run it locally

```bash
git clone <this-repo>
cd agentflow
cp .env.example .env   # fill in HASURA_GRAPHQL_ADMIN_SECRET, GROQ_API_KEY (optional)

# 1. Start Postgres + Hasura + functions + auth
docker compose up -d

# 2. Apply Hasura metadata (tables, relationships, permissions, actions)
npx hasura metadata apply --project ./nhost --admin-secret $HASURA_GRAPHQL_ADMIN_SECRET

# 3. Create two users through the auth API, verify their MailHog emails,
#    then put their real auth.users IDs into scripts/seed.sql. (The demo
#    frontend intentionally exposes sign-in only; it has no sign-up screen.)
#    Seed the two-org demo data.
psql postgres://postgres:postgres@localhost:5432/agentflow -f scripts/seed.sql

# 4. Frontend
cd frontend
cp .env.local.example .env.local
npm install
npm run dev   # http://localhost:3000
```

If `nhost` CLI is available (`npm i -g nhost`), `nhost up` will do steps 1–2
in one command using `nhost/` as the project root — that layout is what
this repo follows.

**No GROQ_API_KEY?** `llm_call` steps still run — they return a labeled
stub response with a disclosed artificial delay instead of failing the
whole workflow, per the assignment's explicit allowance for that case.

## Verification performed

The stack has been exercised end-to-end, both locally and on the deployed
cloud instance:

- Manual Run from the dashboard created a run, executed the LLM stub,
  conditional branch, and HTTP step, then paused at the approval gate.
- The live `/runs/<id>` view displayed step updates and changed from
  `paused` to `succeeded` after approval.
- A user from Org B received `403` when attempting to approve an Org A
  step (verified via a direct GraphQL mutation call against the cloud
  Hasura endpoint, bypassing the UI entirely); an Org A owner approved it
  successfully, and the handler enforces the configured owner/editor rule.
- A secret-protected webhook trigger was invoked successfully via the
  deployed Nhost Functions endpoint and completed after approval.
- Workflow editing was verified: existing definitions load pre-filled, and
  workflow details, step configuration/order, and triggers can be saved.
- `npm run build` completes successfully in `frontend/`.
- Cross-org isolation confirmed at both the UI layer (an Org B user sees
  only Org B, with no way to reach Org A's dashboard, workflow data, or
  workflow editor)
  and the API layer (a direct `approveStep` call against an Org A
  `step_run_id`, authenticated as an Org B user, was rejected
  server-side with `"Only an owner/editor in this org can approve this step"`).

## Deploying the frontend

The frontend can be deployed to Vercel once the local Docker services are
replaced by publicly reachable Auth, Hasura GraphQL/WS, and Functions URLs.
Set the corresponding `NEXT_PUBLIC_NHOST_*` / `NEXT_PUBLIC_HASURA_*`
environment variables in Vercel. `localhost` values in `.env.local` are for
local development only and will not work from Vercel.

## Notable bug fixed during cloud deployment

The frontend's `workflows` query was firing before the Nhost auth session
finished restoring on page load/reload, sending the request as the
`public` (unauthenticated) role — which correctly has no access to
`workflows` — and surfacing as a confusing
`field 'workflows' not found in type: 'query_root'` error. Fixed by
gating the query on `useAuthenticationStatus()` in
`app/org/[orgId]/page.tsx`, so the query pauses until the session is
confirmed authenticated.

## Architecture in one paragraph

Every write to `workflow_runs` / `step_runs` goes through a Hasura Action
(`triggerWorkflowRun`, `approveStep`) or a system entry point (the cron
trigger for `scheduled`, the Postgres event trigger for `db_event`) —
never through a raw Hasura mutation from the `user` role. That's
deliberate: `workflow_runs`/`step_runs` have **no insert/update
permissions** for the `user` role at all (see
`nhost/metadata/databases/default/tables/public_workflow_runs.yaml`).
Authoring data (`workflows`, `workflow_steps`, `workflow_triggers`) *is*
written directly via Hasura mutations from the frontend, protected by the
two permission layers described below. The subscription
(`SUBSCRIBE_STEP_RUNS` in `frontend/lib/queries.ts`) reads live off
`step_runs`, which the engine (`nhost/functions/_lib/engine.ts`) updates
step-by-step as it executes.

The Functions service verifies `x-hasura-admin-secret` on Action, cron, and
database-event routes. This prevents a caller from bypassing Hasura and
forging an Action body with arbitrary `session_variables`; only the webhook
route is publicly callable, and it requires its individual webhook secret.

## The two permission layers

**Layer 1 — org + role scoping.** Every select/insert/update/delete
permission on every org-scoped table filters through a relationship chain
back to `org_members` and checks `user_id = X-Hasura-User-Id` — never role
alone. Concretely: `workflows` → `organization` → `org_members`. This is
why an editor in Org A can't see or touch Org B's data even with the same
role — the row simply isn't reachable through the relationship filter for
a user who isn't in `org_members` for that org. See any table file in
`nhost/metadata/databases/default/tables/` for the pattern.

**Layer 2 — step-level gating.** `workflow_steps` and `workflow_triggers`
have an *additional* `_or` clause in their insert/update `check`
expressions: if the row being written is `db_write`/`notify` (steps) or
`webhook` (triggers), the org-membership check tightens from
`role IN (owner, editor)` to `role = owner`. This is enforced by Postgres
via Hasura's permission system, not application code — see
`public_workflow_steps.yaml` and `public_workflow_triggers.yaml`.

**The one thing that *isn't* a Hasura permission**: clearing an
`approval_gate`. The spec calls this out explicitly — it's a mid-execution
decision (does resuming the run), not a plain row read/write, so the role
check lives in `nhost/functions/approveStep.ts` instead. `step_runs` has no
`user`-role update permission at all; the Action does the check with the
admin secret after verifying the caller is an owner/editor in the workflow's
organization.

## Retry / quota / trigger notes

- `llm_call` and `http_request` retry up to 2 extra times (3 attempts
  total) with linear backoff — `runStepWithRetry` in `engine.ts`. The
  `attempt_count` is incremented for every actual attempt, so the live UI
  shows retry counts accurately.
- Quota is checked *before* a run starts (`triggerWorkflowRun.ts`,
  `webhookTrigger.ts`, `scheduledRunner.ts`, `dbEventInbound.ts`) and
  incremented once the run reaches `succeeded` (`engine.ts`,
  `executeFrom`'s final branch) — a run that fails partway doesn't consume
  quota, per "on completion."
- `notify` writes a `notification_events` row; its Hasura Event Trigger
  delivers the Slack/email-compatible POST independently, with three retries.
- Webhook trigger: `POST /webhookTrigger?trigger_id=<trigger-id>` with header
  `x-webhook-secret` matching `workflow_triggers.config.secret`.
- Scheduled trigger: Hasura cron trigger polls `scheduledRunner` every
  minute; it matches each enabled `scheduled` trigger's `config.cron`
  against the current time with a small dependency-free cron matcher.
- DB-event trigger: a Postgres `leads` table exists as a demo "external"
  table. Inserting a row fires a Hasura Event Trigger →
  `dbEventInbound.ts`, which starts a run for any `db_event` trigger
  watching `leads` for that row's org.

## Final Task walkthrough

See `docs/writeup.md` for the schema/permission write-up, and
`scripts/seed.sql` for the two-org, two-user setup used in the demo
recording. The short version of the six-part scenario:

1. Sign in as Org A owner → `/org/<org-a-id>` shows Org A's workflows only.
2. Build "Lead triage": `llm_call` → `conditional_branch` → `http_request`
   / `approval_gate` (seed script has this pre-built).
3. Trigger it manually (Run button) — and separately via the seeded webhook:
   - Local: `curl -X POST 'http://localhost:3001/webhookTrigger?trigger_id=20000000-0000-0000-0000-000000000002' -H "x-webhook-secret: demo-webhook-secret" -H "content-type: application/json" -d '{"lead":"demo"}'`
   - Cloud: `curl -X POST 'https://urxfkigkctgfpkrbpfdv.functions.ap-south-1.nhost.run/v1/webhookTrigger?trigger_id=20000000-0000-0000-0000-000000000002' -H "x-webhook-secret: demo-webhook-secret" -H "content-type: application/json" -d '{"lead":"demo"}'`
4. Watch `/runs/<run-id>` update live via subscription, including
   `paused` when it hits the approval_gate; approve it as an Org A
   owner/editor.
5. Sign in as an Org B user → `/org/<org-a-id>` (typed directly) returns
   nothing — the Hasura select permission filter excludes every row, so
   there's no 403 to probe, just an empty result set.
6. Attempt `approveStep` on an Org A `step_run_id` as an Org B user →
   `getMemberRole` returns `null` → 403 (`"Only an owner in this org can
   owner/editor in this org can approve this step"`).

## Repo layout

```
nhost/
  migrations/default/001_init_schema.{up,down}.sql
  metadata/
    databases/default/tables/*.yaml   # relationships + both permission layers
    actions.yaml, actions.graphql     # triggerWorkflowRun, approveStep, dbEventInbound
    cron_triggers.yaml                # scheduled trigger polling
  functions/
    _lib/db.ts        # admin GraphQL client + role helpers
    _lib/engine.ts     # the execution engine (retry, branch, pause/resume)
    _lib/llm.ts         # Groq call + disclosed stub fallback
    triggerWorkflowRun.ts / approveStep.ts / webhookTrigger.ts
    scheduledRunner.ts / dbEventInbound.ts
frontend/
  app/page.tsx                        # sign in, org picker
  app/org/[orgId]/page.tsx            # dashboard: workflows, quota, run/edit buttons
  app/org/[orgId]/workflows/new/      # builder: steps + trigger
  app/org/[orgId]/workflows/[workflowId]/edit/
                                      # editor: existing workflow definitions
  app/runs/[runId]/page.tsx           # live subscription view + approve UI
docs/writeup.md                       # ~1 page schema/permission write-up
scripts/seed.sql                      # two-org demo data
```
