import express from 'express';
import triggerWorkflowRun from './triggerWorkflowRun';
import approveStep from './approveStep';
import scheduledRunner from './scheduledRunner';
import dbEventInbound from './dbEventInbound';
import webhookTrigger from './webhookTrigger';

const app = express();
app.use(express.json());

// Hasura Actions
app.post('/triggerWorkflowRun', triggerWorkflowRun);
app.post('/approveStep', approveStep);

// Hasura Cron Trigger
app.post('/scheduledRunner', scheduledRunner);

// Hasura Event Trigger (fires on leads INSERT)
app.post('/dbEventInbound', dbEventInbound);

// External inbound webhook (unauthenticated except for the trigger secret)
app.post('/webhookTrigger/:trigger_id', webhookTrigger);

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`AgentFlow functions listening on :${port}`));

export default app;
