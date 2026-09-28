import { KINDS } from '../lib/nodeMeta';

export const DND_MIME = 'application/x-agent-canvas-kind';

export function Palette({ onAdd }: { onAdd: (key: string) => void }) {
  const groups = ['Triggers', 'Steps', 'People', 'Context', 'Logic', 'Output', 'Actions'] as const;
  return (
    <div className="palette">
      {groups.map((g) => (
        <div key={g} className="pal-group">
          <div className="pal-title">{g}</div>
          {KINDS.filter((k) => k.group === g).map((k) => (
            <button
              key={k.key}
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
          ))}
        </div>
      ))}
    </div>
  );
}
