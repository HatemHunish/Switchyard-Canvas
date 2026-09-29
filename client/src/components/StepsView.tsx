import type { Edge } from '@xyflow/react';
import { useMemo } from 'react';
import { outline, type OutlineStep } from '../lib/describe';
import { useSimple } from '../lib/mode';
import { usePlugins } from '../lib/plugins';
import type { NodeRun, WfEdge, WfNode } from '../types';
import type { FlowNodeType } from './nodes/FlowNode';

const STATUS: Record<string, string> = { running: 'running…', queued: 'waiting to start', success: 'done', failed: 'failed', skipped: 'skipped', cancelled: 'stopped', waiting: 'waiting for you' };

interface Props {
  nodes: FlowNodeType[];
  edges: Edge[];
  selectedId: string | null;
  runs?: Record<string, NodeRun>;
  onSelect: (id: string) => void;
  /** Add a step after this one (on the yes/no branch for conditions and reviews); null = first step. */
  onInsert: (afterId: string | null, handle: string | null) => void;
}

const branchLabel = (s: OutlineStep) => (s.branch!.of === 'approved' ? (s.branch!.label === 'yes' ? 'If you approve' : 'If you reject') : s.branch!.label === 'yes' ? 'If yes' : 'Otherwise');

/** The workflow as a readable list: the same steps and settings as the canvas. */
export function StepsView({ nodes, edges, selectedId, runs, onSelect, onInsert }: Props) {
  const simple = useSimple();
  const catalog = usePlugins();
  const wfNodes: WfNode[] = useMemo(() => nodes.map((n) => ({ id: n.id, kind: n.data.kind, position: n.position, label: n.data.label, data: n.data.config })), [nodes]);
  const wfEdges: WfEdge[] = useMemo(() => edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })), [edges]);
  const steps = useMemo(() => outline(wfNodes, wfEdges), [wfNodes, wfEdges, catalog]);
  const hasTrigger = wfNodes.some((n) => n.kind.startsWith('trigger.'));
  const outgoing = (id: string, handle?: string) => wfEdges.filter((e) => e.source === id && e.sourceHandle !== 'team' && e.sourceHandle !== 'revise' && (handle ? e.sourceHandle === handle : true));

  const status = (id: string) => {
    const st = runs?.[id]?.status;
    return st && st !== 'pending' ? <span className={`fnode-status st-${st}`}>{STATUS[st] ?? st}</span> : null;
  };

  const card = (n: WfNode, text: string, detail: string, icon: string, extra?: React.ReactNode) => (
    <button className={`step-card ${selectedId === n.id ? 'on' : ''}`} onClick={() => onSelect(n.id)} aria-pressed={selectedId === n.id}>
      <span className="step-icon" aria-hidden>
        {icon}
      </span>
      <span className="step-body">
        <span className="step-title">{text}</span>
        {detail && <span className="step-detail">{detail}</span>}
        {extra}
      </span>
      {status(n.id)}
    </button>
  );

  return (
    <div className="steps-view">
      <div className="steps-inner">
        {!hasTrigger && (
          <div className="steps-empty">
            <p>
              <b>How should it start?</b> Pick a starting point: a Run button, a schedule, or a file arriving in a folder.
            </p>
            <button className="btn primary sm" onClick={() => onInsert(null, null)}>
              + Choose how it starts
            </button>
          </div>
        )}
        <ol className="steps-list">
          {steps.map((s, i) => {
            const n = s.node;
            const branch = n.kind === 'condition' || n.kind === 'human';
            const last = !outgoing(n.id).length;
            return (
              <li key={n.id} style={{ marginInlineStart: s.depth * 26 }} className={s.depth ? 'in-branch' : ''}>
                {s.branch && <div className="step-branch">{branchLabel(s)}</div>}
                <div className="step-line">
                  <span className="step-num">{i + 1}</span>
                  {card(
                    n,
                    s.text,
                    s.detail,
                    s.icon,
                    <>
                      {s.parallel && <span className="step-tag">at the same time as the step above</span>}
                      {s.uses.length > 0 && (
                        <span className="step-chips">
                          Uses:{' '}
                          {s.uses.map((u) => (
                            <span
                              key={u.id}
                              role="button"
                              tabIndex={0}
                              className="chip-sm clickable"
                              onClick={(e) => (e.stopPropagation(), onSelect(u.id))}
                              onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), onSelect(u.id))}
                            >
                              {u.kind === 'dataset' ? '🗂️' : '🧠'} {u.data.name}
                            </span>
                          ))}
                        </span>
                      )}
                      {s.loopTo && <span className="step-tag">if you send it back, “{s.loopTo.data.name}” revises it</span>}
                    </>,
                  )}
                </div>
                {s.team.length > 0 && (
                  <ul className="step-team">
                    {s.team.map((t) => (
                      <li key={t.id}>
                        {card(t, `${t.data.name}: ${t.data.description || 'team member'}`, 'Works when the team lead hands it a task', '✦')}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="step-add">
                  {branch ? (
                    <>
                      <button className="linkbtn small" onClick={() => onInsert(n.id, 'true')}>
                        + {n.kind === 'human' ? 'If approved' : 'If yes'}
                      </button>
                      <button className="linkbtn small" onClick={() => onInsert(n.id, 'false')}>
                        + {n.kind === 'human' ? 'If rejected' : 'Otherwise'}
                      </button>
                    </>
                  ) : (
                    <button className="linkbtn small" onClick={() => onInsert(n.id, null)} title={last ? 'Add a step at the end' : 'Insert a step here'}>
                      + {last ? 'Add a step' : 'Insert a step here'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {simple && steps.length > 0 && <p className="field-hint steps-hint">Click a step to change it. The Canvas view shows the same steps as boxes and connections.</p>}
      </div>
    </div>
  );
}
