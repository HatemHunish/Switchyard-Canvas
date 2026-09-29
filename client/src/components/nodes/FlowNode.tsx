import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { FORMATS, isAgentLike, isBranching, isStore, isTrigger, metaOf, subtitle } from '../../lib/nodeMeta';
import { usePlugins } from '../../lib/plugins';
import { useSimple } from '../../lib/mode';
import type { NodeKind, NodeRun } from '../../types';

export type FlowData = {
  kind: NodeKind;
  label?: string;
  config: Record<string, any>;
  /** Injected for display only; never saved. */
  run?: Omit<NodeRun, 'events'>;
  hasIssue?: boolean;
  /** Display only: the orchestrator this agent is a team member of. */
  workerOf?: string;
};

export type FlowNodeType = Node<FlowData, 'flow'>;

const STATUS_TEXT: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  success: 'done',
  failed: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
  waiting: 'waiting for you',
};

function duration(run?: FlowData['run']) {
  if (!run?.startedAt) return '';
  const ms = (run.finishedAt ?? Date.now()) - run.startedAt;
  return ms < 1000 ? '' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

function FlowNodeImpl({ data, selected }: NodeProps<FlowNodeType>) {
  // Source titles/icons come from the plugin catalog, which loads after the canvas.
  usePlugins();
  const simple = useSimple();
  const meta = metaOf(data.kind, data.config);
  const kindTitle = simple && meta.simple ? meta.simple.title : meta.title;
  const sub = subtitle(data.kind, data.config, simple);
  const title =
    isAgentLike(data.kind) || isStore(data.kind)
      ? data.config.name || meta.title
      : data.kind === 'human'
        ? data.config.title || data.label || meta.title
        : data.kind === 'output'
          ? `${FORMATS.find((f) => f.value === data.config.format)?.label ?? 'File'} output`
          : data.label || meta.title;
  const status = data.run?.status;
  const condition = isBranching(data.kind);
  const passed = condition && status === 'success' ? data.run?.output?.pass : undefined;
  const st = data.run?.output?.structured as { newCount?: number; count?: number } | undefined;
  const counts =
    status === 'success' && st && typeof st === 'object'
      ? data.kind === 'source' && typeof st.newCount === 'number'
        ? `${st.newCount} new`
        : data.kind === 'insight' && typeof st.count === 'number'
          ? `${st.count} labelled`
          : ''
      : '';

  return (
    <div
      className={`fnode kind-${data.kind.replace('.', '-')} ${selected ? 'selected' : ''} ${status ? `st-${status}` : ''}`}
      style={{ ['--kind' as string]: meta.color }}
    >
      {!isTrigger(data.kind) && !isStore(data.kind) && <Handle type="target" position={Position.Left} />}
      <div className="fnode-head">
        <span className="fnode-icon" aria-hidden>
          {meta.icon}
        </span>
        <span className="fnode-title" title={title}>
          {title}
        </span>
        {data.hasIssue && (
          <span className="fnode-issue" title="This step needs attention">
            !
          </span>
        )}
      </div>
      <div className="fnode-sub" title={sub}>
        {sub}
      </div>
      <div className="fnode-foot">
        <span className="fnode-kind">{kindTitle}</span>
        {status && status !== 'pending' && (
          <span className={`fnode-status st-${status}`}>
            {status === 'running' && <span className="spinner" />}
            {passed !== undefined ? (data.kind === 'human' ? (passed ? 'approved' : 'rejected') : passed ? 'yes' : 'no') : STATUS_TEXT[status]}
            {counts && ` · ${counts}`}
            {duration(data.run) && ` · ${duration(data.run)}`}
          </span>
        )}
      </div>
      {condition ? (
        <>
          <Handle type="source" position={Position.Right} id="true" className="h-true" style={{ top: '35%' }} />
          <Handle type="source" position={Position.Right} id="false" className="h-false" style={{ top: '72%' }} />
          <span className="hlabel hl-true">yes</span>
          <span className="hlabel hl-false">no</span>
          {data.kind === 'human' && (
            <>
              <Handle type="source" position={Position.Bottom} id="revise" className="h-loop" title="Drag back to an earlier agent to revise on reject" />
              <span className="hlabel hl-loop">↩ revise</span>
            </>
          )}
        </>
      ) : isStore(data.kind) ? (
        <Handle type="source" position={Position.Bottom} className={`h-memory ${data.kind === 'dataset' ? 'h-dataset' : ''}`} />
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
      {isAgentLike(data.kind) && <Handle type="target" position={Position.Top} id="memory" className="h-memory" style={data.kind === 'agent' ? { left: '68%' } : undefined} />}
      {data.kind === 'agent' && <Handle type="target" position={Position.Top} id="lead" className="h-team" style={{ left: '32%' }} title="Connect an orchestrator's team handle here" />}
      {isAgentLike(data.kind) && <Handle type="target" position={Position.Bottom} id="loop" className="h-loop" style={data.kind === 'orchestrator' ? { left: '72%' } : undefined} />}
      {data.kind === 'orchestrator' && (
        <>
          <Handle type="source" position={Position.Bottom} id="team" className="h-team" style={{ left: '28%' }} title="Drag to agents to add them to the team" />
          <span className="hlabel hl-team">team</span>
        </>
      )}
      {data.workerOf && <span className="worker-badge">team: {data.workerOf}</span>}
    </div>
  );
}

export const FlowNode = memo(FlowNodeImpl);
