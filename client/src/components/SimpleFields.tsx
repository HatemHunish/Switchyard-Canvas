import { useState } from 'react';
import { api } from '../api';
import { tildify, useSettingsState } from '../lib/mode';
import {
  CAPABILITIES,
  capsFromTools,
  NUMBER_OPS,
  parseSchedule,
  QUALITY,
  ruleExpression,
  ruleFields,
  scheduleData,
  scheduleText,
  TEXT_OPS,
  toolsFromCaps,
  WEEKDAYS,
  type CapKey,
  type Rule,
  type Schedule,
} from '../lib/plain';

/** "What can it use?" as checkboxes instead of tool names. */
export function CapabilityPicker({ tools, onChange }: { tools: string[]; onChange: (tools: string[]) => void }) {
  const { caps, other } = capsFromTools(tools);
  const toggle = (k: CapKey, on: boolean) => {
    const next = new Set(caps);
    if (on) next.add(k);
    else next.delete(k);
    onChange(toolsFromCaps(next, other));
  };
  return (
    <div className="field">
      <span className="field-label">What can it use?</span>
      <div className="check-grid">
        {CAPABILITIES.map((c) => (
          <label key={c.key} className={`check ${c.key === 'run' ? 'risky' : ''}`}>
            <input type="checkbox" checked={caps.has(c.key)} onChange={(e) => toggle(c.key, e.target.checked)} />
            <span>
              {c.label}
              <small>{c.hint}</small>
            </span>
          </label>
        ))}
      </div>
      {other.length > 0 && <span className="field-hint">Plus {other.length} advanced permission{other.length > 1 ? 's' : ''} (see Advanced mode).</span>}
      {!caps.size && !other.length && <span className="field-hint">Nothing ticked: it can only think and write its answer.</span>}
    </div>
  );
}

export function QualityPicker({ model, onChange }: { model?: string; onChange: (model: string) => void }) {
  const current = QUALITY.find((q) => q.value === model) ? model : model ? 'custom' : 'sonnet';
  return (
    <div className="field">
      <span className="field-label">Quality</span>
      <div className="seg" role="radiogroup" aria-label="Quality">
        {QUALITY.map((q) => (
          <button key={q.value} type="button" role="radio" aria-checked={current === q.value} className={current === q.value ? 'on' : ''} onClick={() => onChange(q.value)}>
            {q.label}
          </button>
        ))}
      </div>
      <span className="field-hint">{current === 'custom' ? `Custom model “${model}” (Advanced mode).` : QUALITY.find((q) => q.value === current)?.hint}</span>
    </div>
  );
}

/** Private workspace by default, or a folder chosen with the Mac's folder dialog. */
export function FolderPicker({ value, onChange, label = 'Which folder can it work in?' }: { value: string; onChange: (path: string) => void; label?: string }) {
  const { workspaceDir } = useSettingsState();
  const [busy, setBusy] = useState(false);
  const isWorkspace = !value || value === workspaceDir || value === tildify(workspaceDir);
  const choose = async () => {
    setBusy(true);
    try {
      const r = await api.chooseFolder('Choose the folder this step can work in');
      if (r.path) onChange(tildify(r.path));
    } catch (err) {
      const typed = prompt(`${(err as Error).message}\n\nFolder path:`, value);
      if (typed) onChange(typed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="folder-pick">
        <label className="radio-row">
          <input type="radio" checked={isWorkspace} onChange={() => onChange(tildify(workspaceDir))} />
          <span>
            <b>Its own private folder</b>
            <span className="field-hint">Safest: it can’t see any of your files.</span>
          </span>
        </label>
        <label className="radio-row">
          <input type="radio" checked={!isWorkspace} onChange={() => void choose()} />
          <span>
            <b>A folder I choose</b>
            <span className="field-hint">{!isWorkspace ? <code>{value}</code> : 'For tasks about your documents or projects.'}</span>
          </span>
          <button type="button" className="btn sm" onClick={() => void choose()} disabled={busy}>
            {busy ? 'Choosing…' : 'Choose…'}
          </button>
        </label>
      </div>
    </div>
  );
}

/** "Every weekday at 9:00" instead of cron. */
export function SchedulePicker({ config, onChange }: { config: Record<string, any>; onChange: (patch: Record<string, any>) => void }) {
  const [s, setS] = useState<Schedule>(() => parseSchedule(config));
  const update = (patch: Partial<Schedule>) => {
    const next = { ...s, ...patch };
    setS(next);
    if (next.kind !== 'custom') onChange(scheduleData(next));
  };
  return (
    <div className="field">
      <span className="field-label">When should it run?</span>
      <div className="sched">
        <select value={s.kind} onChange={(e) => update({ kind: e.target.value as Schedule['kind'], every: e.target.value === 'hours' ? 1 : e.target.value === 'minutes' ? 15 : s.every })}>
          <option value="minutes">Every few minutes</option>
          <option value="hours">Every few hours</option>
          <option value="daily">Every day</option>
          <option value="weekdays">Every weekday (Mon–Fri)</option>
          <option value="weekly">Once a week</option>
          <option value="monthly">Once a month</option>
          {s.kind === 'custom' && <option value="custom">Custom (set in Advanced)</option>}
        </select>
        {(s.kind === 'minutes' || s.kind === 'hours') && (
          <label className="sched-inline">
            every
            <input type="number" min={1} max={s.kind === 'minutes' ? 59 : 24} value={s.every} onChange={(e) => update({ every: Number(e.target.value) || 1 })} />
            {s.kind === 'minutes' ? 'minutes' : 'hours'}
          </label>
        )}
        {s.kind === 'weekly' && (
          <select value={s.day} onChange={(e) => update({ day: Number(e.target.value) })} aria-label="Day of the week">
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                on {d}
              </option>
            ))}
          </select>
        )}
        {s.kind === 'monthly' && (
          <label className="sched-inline">
            on day
            <input type="number" min={1} max={28} value={s.day} onChange={(e) => update({ day: Number(e.target.value) || 1 })} />
          </label>
        )}
        {['daily', 'weekdays', 'weekly', 'monthly'].includes(s.kind) && (
          <label className="sched-inline">
            at
            <input type="time" value={s.time} onChange={(e) => update({ time: e.target.value || '09:00' })} />
          </label>
        )}
      </div>
      <span className="field-hint">
        <b>{scheduleText(config)}</b>. It only runs while this workflow is turned on and the app is open.
      </span>
    </div>
  );
}

/** "If share of negative mentions is more than 30%" instead of a JavaScript expression. */
export function RuleBuilder({ config, upstream, onChange }: { config: Record<string, any>; upstream: Array<{ kind: string; config: Record<string, any> }>; onChange: (patch: Record<string, any>) => void }) {
  const fields = ruleFields(upstream);
  const custom = !config.rule && config.expression && config.expression !== "output.severity === 'high'";
  const rule: Rule = config.rule ?? { field: fields[0].key, op: fields[0].type === 'text' ? 'contains' : '>', value: '' };
  const field = fields.find((f) => f.key === rule.field) ?? fields[0];
  const set = (patch: Partial<Rule>) => {
    const next = { ...rule, ...patch };
    const f = fields.find((x) => x.key === next.field) ?? fields[0];
    if (patch.field) next.op = f.type === 'text' ? 'contains' : '>';
    onChange({ mode: 'expression', rule: next, expression: ruleExpression(next, fields) });
  };
  if (custom)
    return (
      <div className="field">
        <span className="field-label">Rule</span>
        <p className="field-hint">
          This step uses a custom rule: <code>{config.expression}</code>
        </p>
        <button type="button" className="btn sm" onClick={() => set({ field: fields[0].key })}>
          Replace with a simple rule
        </button>
      </div>
    );
  const ops = field.type === 'text' ? TEXT_OPS : NUMBER_OPS;
  return (
    <div className="field">
      <span className="field-label">Go the “yes” way if…</span>
      <div className="rule">
        <select value={field.key} onChange={(e) => set({ field: e.target.value })} aria-label="What to check">
          {fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <select value={rule.op} onChange={(e) => set({ op: e.target.value })} aria-label="Comparison">
          {ops.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {!(rule.op === 'empty' || rule.op === 'notEmpty') && (
          <span className="rule-value">
            <input
              type={field.type === 'text' ? 'text' : 'number'}
              step={field.type === 'sentiment' ? 0.1 : 1}
              value={rule.value}
              placeholder={field.type === 'percent' ? '30' : field.type === 'sentiment' ? '-0.2' : field.type === 'text' ? 'urgent' : '0'}
              onChange={(e) => set({ value: e.target.value })}
              aria-label="Value"
            />
            {field.type === 'percent' && <span>%</span>}
          </span>
        )}
      </div>
      <span className="field-hint">
        {field.type === 'sentiment' ? 'Mood runs from −1 (very negative) to 1 (very positive).' : 'Otherwise it goes the “no” way.'} Connect the green “yes” and red “no” handles to the next steps.
      </span>
    </div>
  );
}
