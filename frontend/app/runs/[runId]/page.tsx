'use client';

import { useSubscription, useMutation } from 'urql';
import { SUBSCRIBE_STEP_RUNS, APPROVE_STEP } from '../../../lib/queries';

const STATUS_CLASS: Record<string, string> = {
  succeeded: 'status-succeeded',
  failed: 'status-failed',
  paused: 'status-paused',
  running: 'status-running',
  pending: '',
};
const BADGE_CLASS: Record<string, string> = {
  succeeded: 'badge-success',
  failed: 'badge-error',
  paused: 'badge-warn',
  running: 'badge-accent',
  pending: '',
};

export default function RunView({ params }: { params: { runId: string } }) {
  const [{ data, error }] = useSubscription({
    query: SUBSCRIBE_STEP_RUNS,
    variables: { runId: params.runId },
  });
  const [, approve] = useMutation(APPROVE_STEP);

  const stepRuns = data?.step_runs ?? [];
  // Hasura subscriptions allow one root selection. The parent run is
  // selected through each step run so status remains live without a second
  // top-level field.
  const run = stepRuns[0]?.workflow_run;
  const pausedStep = stepRuns.find((s: any) => s.status === 'paused' || (run?.status === 'paused' && s.step_order === run.current_step_order));

  async function handleApprove(stepRunId: string, decision: boolean) {
    const result = await approve({ stepRunId, approve: decision });
    if (result.error) alert(result.error.message);
  }

  return (
    <div className="container">
      <div className="eyebrow">Workflow run</div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 16 }}>{params.runId.slice(0, 8)}</span>
        {run && <span className={`badge ${BADGE_CLASS[run.status] ?? ''}`}>{run.status}</span>}
      </h1>

      {error && <p style={{ color: 'var(--error)' }}>{error.message}</p>}

      {run?.status === 'paused' && pausedStep && (
        <div className="card" style={{ marginBottom: 24, borderColor: 'var(--warn)' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>⏸ Awaiting approval — step {pausedStep.step_order}</div>
          <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
            This run is paused at an approval_gate step. Only an owner or editor in this org can clear it —
            checked server-side by the approveStep Action, not a client-side flag.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={() => handleApprove(pausedStep.id, true)}>Approve &amp; resume</button>
            <button className="btn" onClick={() => handleApprove(pausedStep.id, false)}>Reject &amp; cancel run</button>
          </div>
        </div>
      )}

      <div className="rail">
        {stepRuns.map((s: any) => (
          <div key={s.id} className="rail-node">
            <span className={`rail-dot ${STATUS_CLASS[s.status] ?? ''}`} />
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
                  #{s.step_order} · {s.type}
                </span>
                <span className={`badge ${BADGE_CLASS[s.status] ?? ''}`}>{s.status}</span>
              </div>
              {s.attempt_count > 1 && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>retried {s.attempt_count - 1}×</div>
              )}
              {s.output && (
                <pre style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {JSON.stringify(s.output, null, 2)}
                </pre>
              )}
              {s.error && <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 8 }}>{s.error}</div>}
              {s.approved_by && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
                  approved {new Date(s.approved_at).toLocaleString()}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
