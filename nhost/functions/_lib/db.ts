// Shared helper: a thin admin-privileged GraphQL client used by every
// Action/Event/Cron handler. All writes to workflow_runs / step_runs go
// through here, using the admin secret — never through the `user` role —
// because these mutations happen mid-execution and depend on business
// logic (quota, retries, approval-gate role checks) that a static Hasura
// permission can't express.

// Nhost Cloud injects NHOST_GRAPHQL_URL and NHOST_ADMIN_SECRET. Keep the
// local Docker variables as fallbacks so the project remains runnable with
// `docker compose up` too.
const HASURA_URL = process.env.NHOST_GRAPHQL_URL || process.env.HASURA_GRAPHQL_URL || 'http://localhost:8080/v1/graphql';
const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET || process.env.HASURA_GRAPHQL_ADMIN_SECRET || '';

export async function gql<T = any>(query: string, variables: Record<string, any> = {}): Promise<T> {
  const res = await fetch(HASURA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

/** Looks up the caller's role in a given org. Returns null if not a member. */
export async function getMemberRole(userId: string, orgId: string): Promise<'owner' | 'editor' | 'viewer' | null> {
  const data = await gql<{ org_members: { role: string }[] }>(
    `query ($userId: uuid!, $orgId: uuid!) {
      org_members(where: { user_id: { _eq: $userId }, org_id: { _eq: $orgId } }, limit: 1) {
        role
      }
    }`,
    { userId, orgId }
  );
  return (data.org_members[0]?.role as any) ?? null;
}

export function isAtLeast(role: string | null, min: 'owner' | 'editor' | 'viewer'): boolean {
  const order = { viewer: 0, editor: 1, owner: 2 };
  if (!role) return false;
  return order[role as keyof typeof order] >= order[min];
}
