import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type WorkflowView } from '../api';
import { autoLayout } from '../lib/layout';
import { subscribe } from '../lib/live';
import { isAgentLike, isStore, isTrigger, metaByKey, metaOf } from '../lib/nodeMeta';
import { modeNow, tildify, useSimple } from '../lib/mode';
import type { HumanRequest, NodeKind, NodeRun, Run, WfEdge, WfNode } from '../types';
import { ExportDialog } from './ExportDialog';
import { Inspector } from './Inspector';
import { FlowNode, type FlowNodeType } from './nodes/FlowNode';
import { DND_MIME, Palette } from './Palette';
import { RunsPanel } from './RunsPanel';
import { StepsView } from './StepsView';

const nodeTypes = { flow: FlowNode };

const toFlowNode = (n: WfNode): FlowNodeType => ({
  id: n.id,
  type: 'flow',
  position: n.position,
  data: { kind: n.kind, label: n.label, config: n.data ?? {} },
});

function styleEdge(e: Edge): Edge {
  const h = e.sourceHandle;
  if (h === 'revise') return { ...e, targetHandle: 'loop', type: 'smoothstep', className: 'e-loop', label: '↩ revise' };
  if (h === 'team') return { ...e, targetHandle: 'lead', className: 'e-team' };
  return {
    ...e,
    className: h === 'true' ? 'e-true' : h === 'false' ? 'e-false' : undefined,
  };
}

const toFlowEdge = (e: WfEdge): Edge => styleEdge({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null });

const shortId = () => Math.random().toString(36).slice(2, 8);
const isBranchKind = (k: string) => k === 'condition' || k === 'human';

interface ViewedRun {
  run: Run;
  nodes: Record<string, NodeRun>;
}

interface Props {
  workflow: WorkflowView;
  onSaved: (wf: WorkflowView) => void;
  onDelete: () => void;
  notify: (msg: string, kind?: 'ok' | 'err') => void;
  onDirty: (dirty: boolean) => void;
  /** Everything waiting on the user, across all workflows. */
  inbox: HumanRequest[];
  /** Set by "Open in canvas" in the Inbox. */
  focus?: { runId: string; nodeId?: string; nonce: number };
  onOpenPlugins: () => void;
  onOpenInsights: (dataset: string) => void;
}

export function Editor({ workflow, onSaved, onDelete, notify, onDirty, inbox, focus, onOpenPlugins, onOpenInsights }: Props) {
  const simple = useSimple();
  const rf = useReactFlow();
  const [nodes, setNodes] = useState<FlowNodeType[]>(() => workflow.nodes.map(toFlowNode));
  const [edges, setEdges] = useState<Edge[]>(() => workflow.edges.map(toFlowEdge));
  const [name, setName] = useState(workflow.name);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<WorkflowView>(workflow);
  const [runs, setRuns] = useState<Run[]>([]);
  const [viewed, setViewed] = useState<ViewedRun | null>(null);
  const [following, setFollowing] = useState(true);
  const [showRuns, setShowRuns] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [runMenu, setRunMenu] = useState(false);
  const [, tick] = useState(0);
  const followingRef = useRef(following);
  followingRef.current = following;

  // Load run history and show the latest run on the canvas.
  // Opened from the dashboard/inbox for a specific run: don't replace it with "latest run".
  const openedForRun = useRef(!!focus);
  useEffect(() => {
    let alive = true;
    api.runs(workflow.id).then(async (list) => {
      if (!alive) return;
      setRuns(list);
      if (list[0] && !openedForRun.current) {
        const r = await api.run(list[0].id);
        if (alive) setViewed({ run: r.run, nodes: Object.fromEntries(r.nodes.map((n) => [n.nodeId, n])) });
      }
    });
    return () => {
      alive = false;
    };
  }, [workflow.id]);

  // Live updates from the server.
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === 'run' && e.run.workflowId === workflow.id) {
          setRuns((rs) => [e.run, ...rs.filter((r) => r.id !== e.run.id)].sort((a, b) => b.startedAt - a.startedAt));
          setViewed((v) => {
            if (v?.run.id === e.run.id) return { ...v, run: e.run };
            if (followingRef.current && e.run.status === 'running') return { run: e.run, nodes: {} };
            return v;
          });
        } else if (e.type === 'node' && e.workflowId === workflow.id) {
          setViewed((v) => {
            if (!v || v.run.id !== e.node.runId) return v;
            const prev = v.nodes[e.node.nodeId];
            return { ...v, nodes: { ...v.nodes, [e.node.nodeId]: { ...e.node, events: prev?.events ?? [] } } };
          });
        } else if (e.type === 'node.event' && e.workflowId === workflow.id) {
          setViewed((v) => {
            if (!v || v.run.id !== e.runId) return v;
            const prev = v.nodes[e.nodeId] ?? { runId: e.runId, nodeId: e.nodeId, status: 'running' as const, events: [] };
            return { ...v, nodes: { ...v.nodes, [e.nodeId]: { ...prev, events: [...prev.events, e.event] } } };
          });
        }
      }),
    [workflow.id],
  );

  // Keep durations and "next run" times fresh while something is happening.
  const running = viewed?.run.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (!view.enabled) return;
    const t = setInterval(() => api.getWorkflow(workflow.id).then(setView).catch(() => undefined), 30_000);
    return () => clearInterval(t);
  }, [view.enabled, workflow.id]);

  const markDirty = () => setDirty(true);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNodeType>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    if (changes.some((c) => c.type !== 'select' && c.type !== 'dimensions')) markDirty();
    for (const c of changes) {
      if (c.type === 'select' && c.selected) setSelectedId(c.id);
      if (c.type === 'remove') setSelectedId((s) => (s === c.id ? null : s));
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
    if (changes.some((c) => c.type !== 'select')) markDirty();
  }, []);

  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => addEdge(styleEdge({ ...c, id: `e-${shortId()}` } as Edge), es));
    markDirty();
  }, []);

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (c.source === c.target) return false;
      const source = nodes.find((n) => n.id === c.source);
      const target = nodes.find((n) => n.id === c.target);
      if (!source || !target || isTrigger(target.data.kind) || isStore(target.data.kind)) return false;
      // Memory and datasets plug into agents only, through their top "memory" socket.
      if (isStore(source.data.kind)) return isAgentLike(target.data.kind);
      // A review's ↩ revise handle loops back to an agent (its bottom socket).
      if (c.sourceHandle === 'revise') return isAgentLike(target.data.kind);
      // An orchestrator's team handle adds plain agents as its workers.
      if (c.sourceHandle === 'team') return target.data.kind === 'agent' && (c.targetHandle === 'lead' || c.targetHandle == null);
      if (c.targetHandle === 'lead') return false;
      return c.targetHandle !== 'memory' && c.targetHandle !== 'loop';
    },
    [nodes],
  );

  /** A new step of the given palette type, not yet on the canvas. */
  const newNode = (key: string, pos: { x: number; y: number }): FlowNodeType => {
      const meta = metaByKey(key) ?? metaOf(key);
      const kind = meta.kind;
      const config = meta.defaults();
      if (kind === 'agent') config.name = `agent-${nodes.filter((n) => n.data.kind === 'agent').length + 1}`;
      if (kind === 'orchestrator') config.name = `orchestrator-${nodes.filter((n) => n.data.kind === 'orchestrator').length + 1}`;
      // Simple mode: new AI steps start in their own private folder, not your home folder.
      if ((kind === 'agent' || kind === 'orchestrator') && modeNow().mode === 'simple') config.cwd = tildify(modeNow().workspaceDir);
      if (kind === 'action' && config.action === 'email' && !config.to && modeNow().userEmail) config.to = modeNow().userEmail;
      const id = `${key.replace('trigger.', '').replace('action.', '').replace(/^source:[\w-]+\./, 'src-')}-${shortId()}`;
      const label = kind === 'source' ? meta.title : undefined;
      return { id, type: 'flow', position: pos, selected: true, data: { kind, config, label } };
  };

  const addNode = useCallback(
    (key: string, position?: { x: number; y: number }) => {
      const pos =
        position ??
        (() => {
          const el = document.querySelector('.react-flow');
          const r = el?.getBoundingClientRect();
          return rf.screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 800) / 2 - 120, y: (r?.top ?? 0) + (r?.height ?? 600) / 2 - 40 });
        })();
      const node = newNode(key, pos);
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node]);
      setSelectedId(node.id);
      markDirty();
    },
    [nodes, rf],
  );

  /**
   * Steps view: put a new step right after another one (on a yes/no branch for
   * conditions and reviews), taking over its outgoing connections, then re-tidy.
   */
  const insertAfter = (afterId: string | null, handle: string | null, key: string) => {
    const after = nodes.find((n) => n.id === afterId);
    const node = newNode(key, after ? { x: after.position.x + 150, y: after.position.y + 60 } : { x: 0, y: 0 });
    const kind = node.data.kind;
    let nextEdges = edges;
    if (after && !isStore(kind) && !isTrigger(kind)) {
      const out = edges.filter((e) => e.source === after.id && e.sourceHandle !== 'team' && e.sourceHandle !== 'revise' && (handle ? e.sourceHandle === handle : true));
      nextEdges = [
        ...edges.filter((e) => !out.includes(e)),
        styleEdge({ id: `e-${shortId()}`, source: after.id, target: node.id, sourceHandle: handle ?? null } as Edge),
        ...out.map((e) => styleEdge({ id: `e-${shortId()}`, source: node.id, target: e.target, sourceHandle: isBranchKind(kind) ? 'true' : null } as Edge)),
      ];
    } else if (after && isStore(kind)) {
      // A store attaches to the step it was added from (if that's an AI step).
      if (isAgentLike(after.data.kind)) nextEdges = [...edges, styleEdge({ id: `e-${shortId()}`, source: node.id, target: after.id, sourceHandle: null } as Edge)];
    }
    const nextNodes = autoLayout([...nodes.map((n) => ({ ...n, selected: false })), node], nextEdges);
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedId(node.id);
    markDirty();
  };

  const [editorView, setEditorView] = useState<'canvas' | 'steps'>(() => {
    try {
      return (localStorage.getItem('ac.editorView') as 'canvas' | 'steps') || (modeNow().mode === 'simple' ? 'steps' : 'canvas');
    } catch {
      return 'canvas';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('ac.editorView', editorView);
    } catch {
      /* storage unavailable */
    }
    if (editorView === 'canvas') setTimeout(() => rf.fitView({ padding: 0.25, maxZoom: 1 }), 50);
  }, [editorView]);
  const [chooser, setChooser] = useState<{ after: string | null; handle: string | null } | null>(null);

  const onDrop = (e: React.DragEvent) => {
    const key = e.dataTransfer.getData(DND_MIME);
    if (!key) return;
    e.preventDefault();
    addNode(key, rf.screenToFlowPosition({ x: e.clientX - 120, y: e.clientY - 30 }));
  };

  const serialize = () => ({
    name,
    nodes: nodes.map<WfNode>((n) => ({ id: n.id, kind: n.data.kind, position: n.position, label: n.data.label || undefined, data: n.data.config })),
    edges: edges.map<WfEdge>((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  });

  const save = async (extra: { enabled?: boolean } = {}): Promise<WorkflowView | null> => {
    setSaving(true);
    try {
      const saved = await api.saveWorkflow(workflow.id, { ...serialize(), ...extra });
      setView(saved);
      setDirty(false);
      onSaved(saved);
      return saved;
    } catch (err) {
      const e = err as ApiError;
      notify(e.issues?.length ? `${e.message}: ${e.issues.map((i) => i.message).join(' ')}` : e.message, 'err');
      if (e.issues?.length) setShowIssues(true);
      return null;
    } finally {
      setSaving(false);
    }
  };

  // ⌘S / Ctrl+S saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleEnabled = async () => {
    const next = !view.enabled;
    // Before it starts sending things on its own, say plainly what will go out.
    if (next) {
      const sends = nodes.flatMap((n) => {
        const c = n.data.config;
        if (n.data.kind !== 'action') return [];
        if (c.action === 'email' && (c.via === 'smtp' || c.sendNow)) return [`email ${c.to || '(no recipient yet)'}`];
        if (c.action === 'email') return [`prepare email drafts to ${c.to || '(no recipient yet)'}`];
        if (c.action === 'http' && c.url) return [`post messages to ${String(c.url).replace(/^https?:\/\//, '').split('/')[0]}`];
        return [];
      });
      if (sends.length && !confirm(`Once it's on, this workflow will run by itself and ${[...new Set(sends)].join(', ')}.\n\nTurn it on?`)) return;
    }
    const saved = await save({ enabled: next });
    if (saved) notify(next ? 'Enabled: triggers are armed' : 'Disabled: triggers stopped', 'ok');
  };

  const run = async (triggerNodeId?: string) => {
    setRunMenu(false);
    if (dirty && !(await save())) return;
    try {
      setFollowing(true);
      const r = await api.runWorkflow(workflow.id, triggerNodeId);
      setViewed({ run: r, nodes: {} });
    } catch (err) {
      const e = err as ApiError;
      notify(e.issues?.length ? e.issues.map((i) => i.message).join(' ') : e.message, 'err');
      if (e.issues?.length) setShowIssues(true);
    }
  };

  const selectRun = async (id: string) => {
    setFollowing(false);
    const r = await api.run(id);
    setViewed({ run: r.run, nodes: Object.fromEntries(r.nodes.map((n) => [n.nodeId, n])) });
  };

  useEffect(() => {
    if (!focus) return;
    if (focus.nodeId) {
      setSelectedId(focus.nodeId);
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === focus.nodeId })));
    }
    if (viewed?.run.id !== focus.runId) {
      void api.run(focus.runId).then((r) => {
        setFollowing(true);
        setViewed({ run: r.run, nodes: Object.fromEntries(r.nodes.map((n) => [n.nodeId, n])) });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const waitingHere = inbox.filter((r) => r.workflowId === workflow.id);
  const pendingFor = (nodeId: string) => waitingHere.find((r) => r.nodeId === nodeId && r.runId === viewed?.run.id) ?? waitingHere.find((r) => r.nodeId === nodeId);
  const selectNode = (nodeId: string) => {
    setSelectedId(nodeId);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId })));
  };

  const layout = () => {
    setNodes((ns) => autoLayout(ns, edges));
    markDirty();
    setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 50);
  };

  const download = () => {
    const blob = new Blob([JSON.stringify({ ...serialize(), description: view.description }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w-]+/g, '-').toLowerCase() || 'workflow'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const issuesByNode = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const i of view.issues) if (i.nodeId) m.set(i.nodeId, [...(m.get(i.nodeId) ?? []), i.message]);
    return m;
  }, [view.issues]);

  const displayNodes = useMemo(
    () =>
      nodes.map((n) => {
        const r = viewed?.nodes[n.id];
        const lead = edges.find((e) => e.target === n.id && e.sourceHandle === 'team');
        const workerOf = lead ? nodes.find((x) => x.id === lead.source)?.data.config.name : undefined;
        return { ...n, data: { ...n.data, run: r, hasIssue: !dirty && issuesByNode.has(n.id), workerOf } };
      }),
    [nodes, edges, viewed, issuesByNode, dirty],
  );

  const memoryIds = useMemo(() => new Set(nodes.filter((n) => isStore(n.data.kind)).map((n) => n.id)), [nodes]);
  const displayEdges = useMemo(
    () =>
      edges.map((e) => {
        const t = viewed?.nodes[e.target]?.status;
        const s = viewed?.nodes[e.source];
        const activeBranch = s?.output?.pass === undefined || String(s.output.pass) === (e.sourceHandle ?? 'true');
        if (memoryIds.has(e.source)) return { ...e, className: nodes.find((n) => n.id === e.source)?.data.kind === 'dataset' ? 'e-memory e-dataset' : 'e-memory', targetHandle: 'memory', animated: false };
        if (e.sourceHandle === 'team') {
          // Lit while the orchestrator has delegated to this worker.
          return { ...e, animated: viewed?.nodes[e.target]?.status === 'running' };
        }
        if (e.sourceHandle === 'revise') {
          // Animate while the review is looping back (it shows "running" during a revision).
          const looping = viewed?.nodes[e.source]?.status === 'running';
          return { ...e, animated: looping };
        }
        return { ...e, animated: (t === 'running' || t === 'queued') && activeBranch };
      }),
    [edges, viewed, memoryIds, nodes],
  );

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const triggers = nodes.filter((n) => isTrigger(n.data.kind));
  const updateSelected = (fn: (n: FlowNodeType) => FlowNodeType) => {
    setNodes((ns) => ns.map((n) => (n.id === selectedId ? fn(n) : n)));
    markDirty();
  };
  const runStatus = viewed?.run.status;

  return (
    <div className="editor">
      <div className="toolbar">
        <input
          className="wf-name"
          value={name}
          aria-label="Workflow name"
          onChange={(e) => {
            setName(e.target.value);
            markDirty();
          }}
        />
        <button className="btn" onClick={() => save()} disabled={saving || !dirty} title="Save (⌘S)">
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        {view.issues.length > 0 && (
          <div className="issues-wrap">
            <button className="btn warnbtn" onClick={() => setShowIssues(!showIssues)}>
              {simple ? `${view.issues.length} thing${view.issues.length > 1 ? 's' : ''} to fix` : `${view.issues.length} issue${view.issues.length > 1 ? 's' : ''}`}
            </button>
            {showIssues && (
              <div className="popover" onMouseLeave={() => setShowIssues(false)}>
                {dirty && <p className="muted small">Based on the last save.</p>}
                <ul>
                  {view.issues.map((i, k) => (
                    <li
                      key={k}
                      onClick={() => {
                        if (!i.nodeId) return;
                        setSelectedId(i.nodeId);
                        setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === i.nodeId })));
                      }}
                      className={i.nodeId ? 'clickable' : ''}
                    >
                      {i.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <div className="seg view-switch" role="radiogroup" aria-label="View">
          <button role="radio" aria-checked={editorView === 'steps'} className={editorView === 'steps' ? 'on' : ''} onClick={() => setEditorView('steps')} title="The steps as a list, in plain words">
            Steps
          </button>
          <button role="radio" aria-checked={editorView === 'canvas'} className={editorView === 'canvas' ? 'on' : ''} onClick={() => setEditorView('canvas')} title="The steps as boxes and connections">
            Canvas
          </button>
        </div>
        <span className="spacer" />
        <UsageHint runs={runs} />
        <label className={`switch ${view.enabled ? 'on' : ''}`} title={simple ? 'When on, it runs by itself (on its schedule, or when a file arrives)' : 'When enabled, schedule, file and webhook triggers fire automatically'}>
          <input type="checkbox" checked={view.enabled} onChange={toggleEnabled} />
          <span className="track">
            <span className="thumb" />
          </span>
          {simple ? (view.enabled ? 'On' : 'Off') : view.enabled ? 'Enabled' : 'Disabled'}
        </label>
        <div className="run-wrap">
          <button className="btn primary" onClick={() => (triggers.length > 1 ? setRunMenu(!runMenu) : run(triggers[0]?.id))} disabled={!triggers.length}>
            ▶ Run{triggers.length > 1 ? ' ▾' : ''}
          </button>
          {runMenu && (
            <div className="popover right" onMouseLeave={() => setRunMenu(false)}>
              <p className="muted small">Start from trigger:</p>
              {triggers.map((t) => (
                <button key={t.id} className="menu-item" onClick={() => run(t.id)}>
                  {metaOf(t.data.kind).icon} {t.data.label || metaOf(t.data.kind).title}
                </button>
              ))}
            </div>
          )}
        </div>
        {runStatus === 'running' && viewed && (
          <button className="btn danger" onClick={() => api.cancelRun(viewed.run.id)}>
            Stop
          </button>
        )}
        <button className="btn ghost" onClick={() => setShowRuns(!showRuns)}>
          Runs{runs.length ? ` (${runs.length})` : ''}
        </button>
        <div className="more">
          {editorView === 'canvas' && (
            <button className="btn ghost" onClick={layout} title="Arrange nodes left to right">
              Tidy
            </button>
          )}
          {!simple && (
            <>
              <button className="btn ghost" onClick={() => setShowExport(true)} title="Write agent nodes as .claude/agents/*.md">
                Export
              </button>
              <button className="btn ghost" onClick={download} title="Download workflow JSON">
                JSON
              </button>
            </>
          )}
          <button
            className="btn ghost danger"
            onClick={() => {
              if (confirm(`Delete "${name}" and its run history?`)) onDelete();
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {viewed && (
        <div className={`runbar st-${viewed.run.status}`}>
          <span className={`pill st-${viewed.run.status}`}>{viewed.run.status}</span>
          <span>
            {following && viewed.run.status === 'running' ? 'Live run' : 'Showing run'} from {new Date(viewed.run.startedAt).toLocaleString()}
          </span>
          {viewed.run.error && viewed.run.status === 'failed' && <span className="run-err">{viewed.run.error}</span>}
          {waitingHere
            .filter((r) => r.runId === viewed.run.id)
            .map((r) => (
              <button key={r.id} className="btn sm waitbtn" onClick={() => selectNode(r.nodeId)}>
                {r.kind === 'review' ? '👤' : '💬'} Waiting for you: {r.kind === 'review' ? r.title : `${r.nodeName} has a question`}
              </button>
            ))}
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => setViewed(null)}>
            Clear
          </button>
        </div>
      )}

      <div className="workspace">
        {editorView === 'canvas' && <Palette onAdd={(k) => addNode(k)} onOpenPlugins={onOpenPlugins} />}
        {editorView === 'steps' && (
          <StepsView
            nodes={nodes}
            edges={edges}
            selectedId={selectedId}
            runs={viewed?.nodes}
            onSelect={selectNode}
            onInsert={(after, handle) => setChooser({ after, handle })}
          />
        )}
        <div className="canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} hidden={editorView === 'steps'} style={editorView === 'steps' ? { display: 'none' } : undefined}>
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background gap={22} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeStrokeWidth={3} />
          </ReactFlow>
          {nodes.length === 0 && (
            <div className="empty-canvas">
              <h3>Start with a trigger</h3>
              <p>
                Drag a <b>trigger</b> from the left (Manual, Schedule, File watch or Webhook), add <b>Agents</b>, and connect them left to right. Use <b>Condition</b> to branch and{' '}
                <b>Merge</b> to join parallel branches.
              </p>
            </div>
          )}
        </div>
        {selected && (
          <Inspector
            key={selected.id}
            node={selected}
            workflowId={workflow.id}
            workflowName={view.name}
            upstream={edges
              .filter((e) => e.target === selected.id && e.sourceHandle !== 'team' && e.sourceHandle !== 'revise')
              .map((e) => nodes.find((n) => n.id === e.source))
              .filter((n): n is FlowNodeType => !!n && !isStore(n.data.kind))
              .map((n) => ({ kind: n.data.kind, config: n.data.config }))}
            onOpenPlugins={onOpenPlugins}
            onOpenInsights={onOpenInsights}
            webhookToken={view.webhookToken}
            saved={!dirty}
            nodeRun={viewed?.nodes[selected.id]}
            trigger={view.triggers.find((t) => t.nodeId === selected.id)}
            issues={issuesByNode.get(selected.id) ?? []}
            pending={pendingFor(selected.id)}
            team={edges
              .filter((e) => e.source === selected.id && e.sourceHandle === 'team')
              .map((e) => nodes.find((n) => n.id === e.target))
              .filter((n): n is FlowNodeType => !!n)
              .map((n) => ({ id: n.id, name: n.data.config.name as string, description: (n.data.config.description as string) || '' }))}
            workerOf={(() => {
              const lead = edges.find((e) => e.target === selected.id && e.sourceHandle === 'team');
              return lead ? (nodes.find((n) => n.id === lead.source)?.data.config.name as string) : undefined;
            })()}
            onSelectNode={selectNode}
            loopTarget={(() => {
              const loop = edges.find((e) => e.source === selected.id && e.sourceHandle === 'revise');
              return loop ? (nodes.find((n) => n.id === loop.target)?.data.config.name ?? loop.target) : undefined;
            })()}
            notify={notify}
            onChange={(patch) => updateSelected((n) => ({ ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } }))}
            onLabel={(label) => updateSelected((n) => ({ ...n, data: { ...n.data, label } }))}
            onDelete={() => {
              // In the Steps view, removing a step joins the step before it to the ones after it.
              const into = editorView === 'steps' ? edges.filter((e) => e.target === selected.id && !isStore(nodes.find((n) => n.id === e.source)?.data.kind ?? '') && e.sourceHandle !== 'team') : [];
              const from = editorView === 'steps' ? edges.filter((e) => e.source === selected.id && e.sourceHandle !== 'team' && e.sourceHandle !== 'revise') : [];
              const heal = into.length === 1 && !isBranchKind(selected.data.kind) ? from.map((e) => styleEdge({ id: `e-${shortId()}`, source: into[0].source, target: e.target, sourceHandle: into[0].sourceHandle ?? null } as Edge)) : [];
              setNodes((ns) => ns.filter((n) => n.id !== selected.id));
              setEdges((es) => [...es.filter((e) => e.source !== selected.id && e.target !== selected.id), ...heal]);
              setSelectedId(null);
              markDirty();
            }}
            onRun={() => run(selected.id)}
          />
        )}
      </div>

      {showRuns && (
        <RunsPanel
          runs={runs}
          viewedRunId={viewed?.run.id}
          following={following}
          onSelect={selectRun}
          onFollow={() => {
            setFollowing(true);
            if (runs[0]) void selectRun(runs[0].id).then(() => setFollowing(true));
          }}
          onCancel={(id) => api.cancelRun(id)}
          onClose={() => setShowRuns(false)}
        />
      )}

      {chooser && (
        <div className="modal-back" onClick={() => setChooser(null)}>
          <div className="modal step-chooser" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add a step">
            <h3>Add a step{chooser.handle ? (chooser.handle === 'true' ? ' (if yes)' : ' (otherwise)') : ''}</h3>
            <Palette
              onAdd={(k) => {
                insertAfter(chooser.after, chooser.handle, k);
                setChooser(null);
              }}
              onOpenPlugins={onOpenPlugins}
            />
          </div>
        </div>
      )}
      {showExport && <ExportDialog workflowId={workflow.id} agentCount={nodes.filter((n) => n.data.kind === 'agent').length} dirty={dirty} onClose={() => setShowExport(false)} notify={notify} />}
    </div>
  );
}

/** How heavy this workflow usually is on the Claude plan, from its recent runs (API-equivalent cost). */
function UsageHint({ runs }: { runs: Run[] }) {
  const done = runs.filter((r) => r.status === 'success').slice(0, 10);
  if (!done.length) return null;
  const avg = done.reduce((a, r) => a + (r.costUsd || 0), 0) / done.length;
  const [label, cls] = avg < 0.05 ? ['Light on usage', 'light'] : avg < 0.5 ? ['Moderate usage', 'moderate'] : ['Heavy on usage', 'heavy'];
  const mins = done.reduce((a, r) => a + ((r.finishedAt ?? r.startedAt) - r.startedAt), 0) / done.length / 60_000;
  return (
    <span className={`usage-hint ${cls}`} title={`Average of the last ${done.length} run(s): ≈$${avg.toFixed(2)} API-equivalent, ${mins < 1 ? 'under a minute' : `${Math.round(mins)} min`}. Your Claude plan covers this; heavier workflows use up its limits sooner.`}>
      {label}
    </span>
  );
}
