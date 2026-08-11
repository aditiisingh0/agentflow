'use client';

import { useQuery, useMutation } from 'urql';
import { useNhostClient, useUserId, useAuthenticationStatus } from '@nhost/nextjs';
import Link from 'next/link';
import { GET_ORG_WORKFLOWS, TRIGGER_WORKFLOW_RUN } from '../../../lib/queries';

const STATUS_CLASS: Record<string, string> = {
  succeeded: 'badge-success',
  failed: 'badge-error',
  paused: 'badge-warn',
  running: 'badge-accent',
  pending: '',
  cancelled: 'badge-error',
};

export default function OrgDashboard({ params }: { params: { orgId: string } }) {
  const userId = useUserId();
  const { isAuthenticated, isLoading: authLoading } = useAuthenticationStatus();

  const [{ data, fetching, error }, refetch] = useQuery({
    query: GET_ORG_WORKFLOWS,
    variables: { orgId: params.orgId },
    pause: authLoading || !isAuthenticated,
  });
  const [, triggerRun] = useMutation(TRIGGER_WORKFLOW_RUN);

  const myRole = data?.org_members?.find((m: any) => m.user_id === userId)?.role;
  const isViewer = myRole === 'viewer';
  const org = data?.organizations_by_pk;
  // A direct URL to another organization's dashboard returns no rows because
  // Hasura's org-membership filter is applied before this component receives
  // data. Treat that as an explicit access-denied state, rather than falling
  // through to the empty dashboard (which used to expose authoring controls).
  const hasOrgAccess = Boolean(org && myRole);

  async function handleRun(workflowId: string) {
    const result = await triggerRun({ workflowId });
    if (result.error) {
      alert(result.error.message);
      return;
    }
    const runId = result.data?.triggerWorkflowRun?.workflow_run_id;
    if (runId) window.location.href = `/runs/${runId}`;
  }

  if (authLoading) {
    return (
      <div className="container">
        <p style={{ color: 'var(--text-dim)' }}>Loading…</p>
      </div>
    );
  }

  if (!fetching && !error && !hasOrgAccess) {
    return (
      <div className="container" style={{ maxWidth: 560 }}>
        <div className="eyebrow">Organization</div>
        <h1>Access denied</h1>
        <p style={{ color: 'var(--text-dim)' }}>
          You don&apos;t have access to this organization.
        </p>
        <Link href="/" className="btn" style={{ marginTop: 12 }}>
          Back to your organizations
        </Link>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="eyebrow">Organization</div>
      <h1>{org?.name ?? '—'}</h1>

      {org && (
        <div style={{ margin: '12px 0 28px', maxWidth: 320 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>
            <span>Usage this period</span>
            <span>{org.quota_calls_used} / {org.quota_calls_allowed}</span>
          </div>
          <div className="quota-bar">
            <div
              className="quota-bar-fill"
              style={{ width: `${Math.min(100, (org.quota_calls_used / org.quota_calls_allowed) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Workflows</h2>
        {!isViewer && (
          <Link href={`/org/${params.orgId}/workflows/new`} className="btn btn-primary">
            + New workflow
          </Link>
        )}
      </div>

      {fetching && <p style={{ color: 'var(--text-dim)' }}>Loading…</p>}
      {error && <p style={{ color: 'var(--error)' }}>{error.message}</p>}

      <div style={{ display: 'grid', gap: 12 }}>
        {data?.workflows?.map((wf: any) => {
          const lastRun = wf.workflow_runs?.[0];
          return (
            <div key={wf.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{wf.name}</div>
                  <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 2 }}>{wf.description}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                    {wf.workflow_steps.map((s: any) => (
                      <span key={s.id} className="badge">{s.type}</span>
                    ))}
                  </div>
                </div>
                <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
                  {lastRun && (
                    <Link href={`/runs/${lastRun.id}`} className={`badge ${STATUS_CLASS[lastRun.status] ?? ''}`}>
                      last run: {lastRun.status}
                    </Link>
                  )}
                  {!isViewer && (
                    <button className="btn btn-primary" onClick={() => handleRun(wf.id)}>
                      Run
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {data?.workflows?.length === 0 && (
          <p style={{ color: 'var(--text-dim)' }}>No workflows yet. Create one to get started.</p>
        )}
      </div>
    </div>
  );
}
