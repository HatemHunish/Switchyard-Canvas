import { useState } from 'react';
import { KINDS, sourceKinds, type KindMeta } from '../lib/nodeMeta';
import { usePlugins } from '../lib/plugins';

export const DND_MIME = 'application/x-agent-canvas-kind';

function Item({ k, onAdd }: { k: KindMeta; onAdd: (key: string) => void }) {
  return (
    <button
      className="pal-item"
      draggable
      title={`${k.hint}. Drag onto the canvas or click to add.`}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_MIME, k.key);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onAdd(k.key)}
      style={{ ['--kind' as string]: k.color }}
    >
      <span className="pal-icon">{k.icon}</span>
      <span className="pal-text">
        <span className="pal-name">{k.title}</span>
        <span className="pal-hint">{k.hint}</span>
      </span>
    </button>
  );
}

/** Plugin sources, one collapsible row per plugin (there can be many). */
function Sources({ onAdd, onOpenPlugins }: { onAdd: (key: string) => void; onOpenPlugins?: () => void }) {
  const catalog = usePlugins();
  const [open, setOpen] = useState<string | null>(null);
  const plugins = (catalog?.plugins ?? []).filter((p) => p.enabled && p.sources?.length);
  return (
    <div className="pal-group">
      <div className="pal-title">
        Sources
        {onOpenPlugins && (
          <button className="linkbtn pal-manage" onClick={onOpenPlugins} title="Turn plugins on/off, add keys">
            Plugins
          </button>
        )}
      </div>
      {!catalog && <p className="muted small pad">Loading plugins…</p>}
      {catalog && !plugins.length && <p className="muted small pad">No plugins enabled.</p>}
      {plugins.map((p) => {
        const expanded = open === p.id;
        const missingKey = (p.credentials ?? []).some((c) => !c.optional && !p.credentialsSet[c.key]);
        return (
          <div key={p.id} className={`pal-plugin ${expanded ? 'open' : ''}`}>
            <button className="pal-plugin-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : p.id)}>
              <span className="pal-icon">{p.icon}</span>
              <span className="pal-name">{p.name}</span>
              {missingKey && (
                <span className="pal-key" title="Needs a key (Plugins page)">
                  key
                </span>
              )}
              <span className="pal-caret" aria-hidden>
                {expanded ? '▾' : '▸'}
              </span>
            </button>
            {expanded && sourceKinds([p]).map((k) => <Item key={k.key} k={k} onAdd={onAdd} />)}
          </div>
        );
      })}
    </div>
  );
}

export function Palette({ onAdd, onOpenPlugins }: { onAdd: (key: string) => void; onOpenPlugins?: () => void }) {
  const groups = ['Triggers', 'Sources', 'Steps', 'People', 'Context', 'Logic', 'Output', 'Actions'] as const;
  return (
    <div className="palette">
      {groups.map((g) =>
        g === 'Sources' ? (
          <Sources key={g} onAdd={onAdd} onOpenPlugins={onOpenPlugins} />
        ) : (
          <div key={g} className="pal-group">
            <div className="pal-title">{g}</div>
            {KINDS.filter((k) => k.group === g).map((k) => (
              <Item key={k.key} k={k} onAdd={onAdd} />
            ))}
          </div>
        ),
      )}
    </div>
  );
}
