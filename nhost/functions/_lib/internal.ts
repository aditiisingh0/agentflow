import type { Request, Response } from 'express';

/** Restrict Action, cron, and database-event entry points to Hasura. */
export function requireInternalCaller(req: Request, res: Response): boolean {
  const secret = process.env.NHOST_ADMIN_SECRET || process.env.ACTION_SECRET || process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  if (!secret || req.header('x-hasura-admin-secret') !== secret) {
    res.status(401).json({ message: 'Internal Hasura caller required' });
    return false;
  }
  return true;
}
