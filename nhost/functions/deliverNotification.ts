import type { Request, Response } from 'express';
import { gql } from './_lib/db';
import { requireInternalCaller } from './_lib/internal';

/**
 * Hasura Event Trigger handler for a queued notify step. Delivery is kept
 * outside the engine so Hasura can retry the event without rerunning an LLM
 * or the rest of the workflow.
 */
export default async function handler(req: Request, res: Response) {
  if (!requireInternalCaller(req, res)) return;
  const event = req.body.event;
  const row = event?.data?.new;
  if (!row) return res.status(400).json({ message: 'Missing notification event' });

  try {
    if (!row.target) throw new Error('notify step requires config.target');
    const response = await fetch(row.target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: row.message }),
    });
    if (!response.ok) throw new Error(`notification target returned ${response.status}`);
    await setDelivery(row.id, 'delivered', null);
    return res.json({ delivered: true });
  } catch (error: any) {
    await setDelivery(row.id, 'failed', error.message || String(error));
    // A non-2xx response tells Hasura to use the retry policy in metadata.
    return res.status(500).json({ message: error.message || 'Notification delivery failed' });
  }
}

async function setDelivery(id: string, status: 'delivered' | 'failed', error: string | null) {
  await gql(
    `mutation ($id: uuid!, $status: String!, $error: String) {
      update_notification_events_by_pk(
        pk_columns: {id: $id},
        _set: {status: $status, error: $error, delivered_at: "now()"}
      ) { id }
    }`,
    { id, status, error }
  );
}
