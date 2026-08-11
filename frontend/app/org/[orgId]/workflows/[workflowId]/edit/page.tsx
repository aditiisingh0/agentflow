'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from 'urql';
import { useAuthenticationStatus } from '@nhost/nextjs';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  DELETE_WORKFLOW_TRIGGERS,
  GET_WORKFLOW_FOR_EDIT,
  INSERT_WORKFLOW_STEPS,
  INSERT_WORKFLOW_TRIGGERS,
  SHIFT_WORKFLOW_STEPS,
  UPDATE_WORKFLOW,
  UPDATE_WORKFLOW_STEP,
  UPDATE_WORKFLOW_TRIGGER,
} from '../../../../../../lib/queries';

const STEP_TYPES = ['llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate'];
const TRIGGER_TYPES = ['manual', 'webhook', 'scheduled', 'db_event'];

type StepDraft = { id?: string; type: string; name: string; config: string };
type TriggerDraft = { id?: string; type: string; config: string; is_enabled: boolean };

const json = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

export default function EditWorkflow({ params }: { params: { orgId: string; workflowId: string } }) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuthenticationStatus();
  const [{ data, fetching, error }] = useQuery({
    query: GET_WORKFLOW_FOR_EDIT,
    variables: { workflowId: params.workflowId },
    pause: authLoading || !isAuthenticated,
  });
  const [, updateWorkflow] = useMutation(UPDATE_WORKFLOW);
  const [, shiftSteps] = useMutation(SHIFT_WORKFLOW_STEPS);
  const [, updateStep] = useMutation(UPDATE_WORKFLOW_STEP);
  const [, insertSteps] = useMutation(INSERT_WORKFLOW_STEPS);
  const [, updateTrigger] = useMutation(UPDATE_WORKFLOW_TRIGGER);
  const [, insertTriggers] = useMutation(INSERT_WORKFLOW_TRIGGERS);
  const [, deleteTriggers] = useMutation(DELETE_WORKFLOW_TRIGGERS);

  const workflow = data?.workflows_by_pk;
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [triggers, setTriggers] = useState<TriggerDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!workflow || loaded) return;
    setName(workflow.name);
    setDescription(workflow.description ?? '');
    setIsActive(workflow.is_active);
    setSteps(workflow.workflow_steps.map((step: any) => ({
      id: step.id, type: step.type, name: step.name, config: json(step.config),
    })));
    setTriggers(workflow.workflow_triggers.map((trigger: any) => ({
      id: trigger.id, type: trigger.type, config: json(trigger.config), is_enabled: trigger.is_enabled,
    })));
    setLoaded(true);
  }, [workflow, loaded]);

  const originalTriggers = useMemo(() => new Map<string, any>(
    (workflow?.workflow_triggers ?? []).map((trigger: any) => [String(trigger.id), trigger] as [string, any]),
  ), [workflow]);
  const hasActiveRun = Boolean(workflow?.workflow_runs?.length);

  function updateStepDraft(index: number, patch: Partial<StepDraft>) {
    setSteps((current) => current.map((step, i) => i === index ? { ...step, ...patch } : step));
  }
  function moveStep(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= steps.length) return;
    setSteps((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }
  function updateTriggerDraft(index: number, patch: Partial<TriggerDraft>) {
    setTriggers((current) => current.map((trigger, i) => i === index ? { ...trigger, ...patch } : trigger));
  }

  async function handleSave() {
    if (!workflow || hasActiveRun) return;
    setMessage(null);
    if (!name.trim() || steps.length === 0) {
      setMessage('A workflow needs a name and at least one step.');
      return;
    }

    let parsedSteps: Array<StepDraft & { parsedConfig: unknown }>;
    let parsedTriggers: Array<TriggerDraft & { parsedConfig: unknown }>;
    try {
      parsedSteps = steps.map((step) => ({ ...step, parsedConfig: JSON.parse(step.config || '{}') }));
      parsedTriggers = triggers.map((trigger) => ({ ...trigger, parsedConfig: JSON.parse(trigger.config || '{}') }));
    } catch {
      setMessage('Every step and trigger config must contain valid JSON.');
      return;
    }

    setSaving(true);
    try {
      let result = await updateWorkflow({
        id: workflow.id,
        changes: { name: name.trim(), description: description || null, is_active: isActive },
      });
      if (result.error) throw result.error;

      // Shift existing orders out of the final range before assigning the new
      // order. This keeps the database's unique(workflow_id, step_order)
      // constraint valid even when two existing steps are swapped.
      const existingSteps = parsedSteps.filter((step) => step.id);
      if (existingSteps.length) {
        result = await shiftSteps({ workflowId: workflow.id });
        if (result.error) throw result.error;
      }

      const newSteps = parsedSteps
        .map((step, index) => ({ ...step, index }))
        .filter((step) => !step.id);
      let insertedByTemporaryOrder = new Map<number, string>();
      if (newSteps.length) {
        result = await insertSteps({
          steps: newSteps.map((step) => ({
            workflow_id: workflow.id,
            step_order: 1000 + step.index,
            type: step.type,
            name: step.name,
            config: step.parsedConfig,
          })),
        });
        if (result.error) throw result.error;
        insertedByTemporaryOrder = new Map(
          result.data.insert_workflow_steps.returning.map((step: any) => [step.step_order, step.id]),
        );
      }

      for (const [index, step] of parsedSteps.entries()) {
        const id = step.id ?? insertedByTemporaryOrder.get(1000 + index);
        if (!id) throw new Error('Could not save a new workflow step.');
        result = await updateStep({ id, changes: { step_order: index, name: step.name, config: step.parsedConfig } });
        if (result.error) throw result.error;
      }

      const currentIds = new Set<string>(parsedTriggers.flatMap((trigger) => trigger.id ? [trigger.id] : []));
      const removedIds = [...originalTriggers.keys()].filter((id) => !currentIds.has(id));
      const replacementIds: string[] = [];
      for (const trigger of parsedTriggers) {
        const original = trigger.id ? originalTriggers.get(trigger.id) : undefined;
        if (original && original.type === trigger.type) {
          result = await updateTrigger({ id: trigger.id, changes: { config: trigger.parsedConfig, is_enabled: trigger.is_enabled } });
          if (result.error) throw result.error;
        } else {
          if (trigger.id) replacementIds.push(trigger.id);
          result = await insertTriggers({
            triggers: [{ workflow_id: workflow.id, type: trigger.type, config: trigger.parsedConfig, is_enabled: trigger.is_enabled }],
          });
          if (result.error) throw result.error;
        }
      }
      const triggersToDelete = [...removedIds, ...replacementIds];
      if (triggersToDelete.length) {
        result = await deleteTriggers({ ids: triggersToDelete });
        if (result.error) throw result.error;
      }

      router.push(`/org/${params.orgId}`);
    } catch (saveError: any) {
      setMessage(saveError.message || 'Could not save workflow changes.');
    } finally {
      setSaving(false);
    }
  }

  if (authLoading || fetching) return <div className="container">Loading…</div>;
  if (error || !workflow || workflow.org_id !== params.orgId) {
    return (
      <div className="container" style={{ maxWidth: 560 }}>
        <div className="eyebrow">Workflow</div>
        <h1>Access denied</h1>
        <p style={{ color: 'var(--text-dim)' }}>This workflow is unavailable in this organization.</p>
        <Link href={`/org/${params.orgId}`} className="btn" style={{ marginTop: 12 }}>Back to workflows</Link>
      </div>
    );
  }
  if (!loaded) return <div className="container">Loading…</div>;

  return (
    <div className="container">
      <div className="eyebrow">Workflow editor</div>
      <h1 style={{ marginBottom: 8 }}>Edit workflow</h1>
      {hasActiveRun && (
        <p style={{ color: 'var(--warn)', marginBottom: 20 }}>
          This workflow has an active or paused run. Finish it before editing, so that run keeps a consistent definition.
        </p>
      )}

      <div className="card" style={{ marginBottom: 16, display: 'grid', gap: 10 }}>
        <input placeholder="Workflow name" value={name} onChange={(event) => setName(event.target.value)} disabled={hasActiveRun} />
        <textarea placeholder="Description" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} disabled={hasActiveRun} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} disabled={hasActiveRun} />
          Workflow is active
        </label>
      </div>

      <h2 style={{ fontSize: 16 }}>Steps</h2>
      <div className="rail" style={{ marginBottom: 16 }}>
        {steps.map((step, index) => (
          <div key={step.id ?? `new-${index}`} className="rail-node">
            <span className="rail-dot" />
            <div className="card" style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <select value={step.type} onChange={(event) => updateStepDraft(index, { type: event.target.value })} disabled={Boolean(step.id) || hasActiveRun}>
                  {STEP_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <input placeholder="Step name" value={step.name} onChange={(event) => updateStepDraft(index, { name: event.target.value })} disabled={hasActiveRun} style={{ flex: 1 }} />
              </div>
              {step.id && <p style={{ margin: 0, fontSize: 11, color: 'var(--text-dim)' }}>Existing step type is retained to preserve run history.</p>}
              <textarea placeholder="Step config JSON" rows={3} value={step.config} onChange={(event) => updateStepDraft(index, { config: event.target.value })} disabled={hasActiveRun} style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn" onClick={() => moveStep(index, -1)} disabled={hasActiveRun || index === 0}>↑</button>
                <button className="btn" onClick={() => moveStep(index, 1)} disabled={hasActiveRun || index === steps.length - 1}>↓</button>
                {!step.id && <button className="btn" onClick={() => setSteps((current) => current.filter((_, i) => i !== index))} disabled={hasActiveRun}>Remove</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
      <button className="btn" onClick={() => setSteps((current) => [...current, { type: 'llm_call', name: `Step ${current.length + 1}`, config: '{}' }])} disabled={hasActiveRun} style={{ marginBottom: 28 }}>+ Add step</button>

      <h2 style={{ fontSize: 16 }}>Triggers</h2>
      <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
        {triggers.map((trigger, index) => (
          <div key={trigger.id ?? `new-trigger-${index}`} className="card" style={{ display: 'grid', gap: 8 }}>
            <select value={trigger.type} onChange={(event) => updateTriggerDraft(index, { type: event.target.value })} disabled={hasActiveRun}>
              {TRIGGER_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <textarea placeholder="Trigger config JSON" rows={2} value={trigger.config} onChange={(event) => updateTriggerDraft(index, { config: event.target.value })} disabled={hasActiveRun} style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={trigger.is_enabled} onChange={(event) => updateTriggerDraft(index, { is_enabled: event.target.checked })} disabled={hasActiveRun} />
              Enabled
            </label>
            <button className="btn" onClick={() => setTriggers((current) => current.filter((_, i) => i !== index))} disabled={hasActiveRun}>Remove trigger</button>
          </div>
        ))}
      </div>
      <button className="btn" onClick={() => setTriggers((current) => [...current, { type: 'manual', config: '{}', is_enabled: true }])} disabled={hasActiveRun} style={{ marginBottom: 20 }}>+ Add trigger</button>

      {message && <p style={{ color: 'var(--error)', marginBottom: 12 }}>{message}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving || hasActiveRun}>{saving ? 'Saving…' : 'Save changes'}</button>
        <Link href={`/org/${params.orgId}`} className="btn">Cancel</Link>
      </div>
    </div>
  );
}
