'use client';

import { useState } from 'react';
import { useMutation } from 'urql';
import { useRouter } from 'next/navigation';
import { UPSERT_WORKFLOW } from '../../../../../lib/queries';

const STEP_TYPES = ['llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate'];
const TRIGGER_TYPES = ['manual', 'webhook', 'scheduled', 'db_event'];

type StepDraft = { type: string; name: string; config: string };

export default function NewWorkflow({ params }: { params: { orgId: string } }) {
  const router = useRouter();
  const [, upsert] = useMutation(UPSERT_WORKFLOW);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<StepDraft[]>([{ type: 'llm_call', name: 'Step 1', config: '{}' }]);
  const [triggerType, setTriggerType] = useState('manual');
  const [triggerConfig, setTriggerConfig] = useState('{}');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function addStep() {
    setSteps([...steps, { type: 'llm_call', name: `Step ${steps.length + 1}`, config: '{}' }]);
  }
  function removeStep(i: number) {
    setSteps(steps.filter((_, idx) => idx !== i));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  }
  function updateStep(i: number, patch: Partial<StepDraft>) {
    setSteps(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  async function handleSave() {
    setErr(null);
    let parsedSteps, parsedTrigger;
    try {
      parsedSteps = steps.map((s, i) => ({
        step_order: i,
        type: s.type,
        name: s.name,
        config: JSON.parse(s.config || '{}'),
      }));
      parsedTrigger = JSON.parse(triggerConfig || '{}');
    } catch {
      setErr('Step or trigger config must be valid JSON.');
      return;
    }

    setSaving(true);
    const result = await upsert({
      orgId: params.orgId,
      name,
      description,
      steps: parsedSteps,
      triggers: [{ type: triggerType, config: parsedTrigger, is_enabled: true }],
    });
    setSaving(false);

    if (result.error) {
      // this is where a viewer/editor hitting the layer-2 owner-only gate
      // (e.g. adding a db_write/notify step, or a webhook trigger) surfaces
      setErr(result.error.message);
      return;
    }
    router.push(`/org/${params.orgId}`);
  }

  return (
    <div className="container">
      <div className="eyebrow">New workflow</div>
      <h1 style={{ marginBottom: 24 }}>Build a workflow</h1>

      <div className="card" style={{ marginBottom: 16, display: 'grid', gap: 10 }}>
        <input placeholder="Workflow name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea placeholder="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <h2 style={{ fontSize: 16 }}>Steps</h2>
      <div className="rail" style={{ marginBottom: 16 }}>
        {steps.map((s, i) => (
          <div key={i} className="rail-node">
            <span className="rail-dot" />
            <div className="card" style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <select value={s.type} onChange={(e) => updateStep(i, { type: e.target.value })}>
                  {STEP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input
                  placeholder="Step name"
                  value={s.name}
                  onChange={(e) => updateStep(i, { name: e.target.value })}
                  style={{ flex: 1 }}
                />
              </div>
              <textarea
                placeholder='config JSON, e.g. {"prompt":"Summarize {{step0.result}}"}'
                rows={2}
                value={s.config}
                onChange={(e) => updateStep(i, { config: e.target.value })}
                style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button className="btn" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>↓</button>
                <button className="btn" onClick={() => removeStep(i)}>Remove</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <button className="btn" onClick={addStep} style={{ marginBottom: 28 }}>+ Add step</button>

      <h2 style={{ fontSize: 16 }}>Trigger</h2>
      <div className="card" style={{ marginBottom: 20, display: 'grid', gap: 8 }}>
        <select value={triggerType} onChange={(e) => setTriggerType(e.target.value)}>
          {TRIGGER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <textarea
          placeholder='trigger config JSON, e.g. {"cron":"*/5 * * * *"} or {"secret":"..."} for webhook'
          rows={2}
          value={triggerConfig}
          onChange={(e) => setTriggerConfig(e.target.value)}
          style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
        />
        {triggerType === 'webhook' && (
          <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            Only an org owner can create a webhook trigger — enforced by the layer-2 Hasura permission on workflow_triggers.
          </p>
        )}
      </div>

      {err && <p style={{ color: 'var(--error)', marginBottom: 12 }}>{err}</p>}
      <button className="btn btn-primary" onClick={handleSave} disabled={saving || !name}>
        {saving ? 'Saving…' : 'Save workflow'}
      </button>
    </div>
  );
}
