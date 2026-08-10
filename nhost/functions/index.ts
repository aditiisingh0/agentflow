import express from 'express';
import triggerWorkflowRun from './triggerWorkflowRun';
import approveStep from './approveStep';
import scheduledRunner from './scheduledRunner';
import dbEventInbound from './dbEventInbound';
import webhookTrigger from './webhookTrigger';
import deliverNotification from './deliverNotification';

const app = express();
app.use(express.json());

// Action, cron, and event handlers are callable only by Hasura. Without
// this guard, anyone who can reach port 3001 could fabricate
// `session_variables` and impersonate a user when calling an Action handler
// directly. The externally callable webhook route is intentionally excluded:
// it authenticates with its per-trigger secret instead.
const internalSecret = process.env.ACTION_SECRET || process.env.HASURA_GRAPHQL_ADMIN_SECRET;
function requireInternalCaller(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!internalSecret || req.header('x-hasura-admin-secret') !== internalSecret) {
    return res.status(401).json({ message: 'Internal Hasura caller required' });
  }
  next();
}

// Hasura Actions
app.post('/triggerWorkflowRun', requireInternalCaller, triggerWorkflowRun);
app.post('/approveStep', requireInternalCaller, approveStep);

// Hasura Cron Trigger
app.post('/scheduledRunner', requireInternalCaller, scheduledRunner);

// Hasura Event Trigger (fires on leads INSERT)
app.post('/dbEventInbound', requireInternalCaller, dbEventInbound);

// Hasura Event Trigger (fires on notification_events INSERT)
app.post('/deliverNotification', requireInternalCaller, deliverNotification);

// External inbound webhook (unauthenticated except for the trigger secret)
app.post('/webhookTrigger/:trigger_id', webhookTrigger);
app.post('/webhookTrigger', webhookTrigger);

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`AgentFlow functions listening on :${port}`));

export default app;
