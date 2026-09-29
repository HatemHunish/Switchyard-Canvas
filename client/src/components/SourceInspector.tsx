import { useEffect, useState } from 'react';
import { api, type DatasetInfo, type PluginField, type PluginTool, type SourcePreview } from '../api';
import { sourceDef, usePlugins } from '../lib/plugins';
import type { InsightField } from '../types';

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

const optionList = (f: PluginField) => (f.options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
const ago = (t?: number) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** A text field whose list value (one per line) is only cleaned up on blur, so typing isn't disturbed. */
function ListInput({ value, placeholder, onChange }: { value: unknown; placeholder?: string; onChange: (v: string[]) => void }) {
  const list = Array.isArray(value) ? (value as string[]) : String(value ?? '').split('\n');
  return (
    <textarea
      rows={Math.min(6, Math.max(2, list.length + 1))}
      value={list.join('\n')}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value.split('\n'))}
      onBlur={(e) => onChange(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))}
    />
  );
}

/** Dataset picker: existing datasets plus free text for a new one. */
function DatasetInput({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (v: string) => void }) {
  const [sets, setSets] = useState<DatasetInfo[]>([]);
  useEffect(() => {
    void api.datasets().then(setSets).catch(() => undefined);
  }, []);
  return (
    <>
      <input list="datasets-list" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <datalist id="datasets-list">
        {sets.map((s) => (
          <option key={s.id} value={s.name}>{`${s.items} items`}</option>
        ))}
      </datalist>
    </>
  );
}

interface SourceProps {
  config: Record<string, any>;
  workflowId: string;
  workflowName: string;
  nodeId: string;
  onChange: (patch: Record<string, any>) => void;
  onOpenPlugins: () => void;
}

/** Settings of a Source node, rendered from its plugin's field definitions. */
export function SourceFields({ config: d, workflowId, workflowName, nodeId, onChange, onOpenPlugins }: SourceProps) {
  usePlugins();
  const { plugin, def } = sourceDef(d.plugin, d.source);
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [running, setRunning] = useState(false);
  const cfg: Record<string, unknown> = d.config ?? {};
  const setCfg = (key: string, v: unknown) => onChange({ config: { ...cfg, [key]: v } });

  if (!plugin || !def) {
    return (
      <div className="warn">
        This step uses the plugin <b>{d.plugin || '?'}</b> (source “{d.source}”), which isn’t installed. Add it to the plugins folder, then reload plugins.{' '}
        <button className="linkbtn" onClick={onOpenPlugins}>
          Open Plugins
        </button>
      </div>
    );
  }
  const missing = (plugin.credentials ?? []).filter((c) => (def.needs ?? []).includes(c.key) && !plugin.credentialsSet[c.key]);

  const runPreview = async () => {
    setRunning(true);
    setPreview(null);
    try {
      setPreview(await api.previewSource({ plugin: plugin.id, source: def.id, config: cfg, workflowId, nodeId }));
    } catch (err) {
      setPreview({ ok: false, error: (err as Error).message, log: [], ms: 0 });
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="src-plugin">
        <span className="src-plugin-icon">{plugin.icon}</span>
        <span>
          <b>{plugin.name}</b>
          {!plugin.enabled && <span className="warnish"> · turned off</span>}
          <span className="field-hint">{def.hint}</span>
        </span>
        <button className="linkbtn" onClick={onOpenPlugins}>
          Plugin settings
        </button>
      </div>
      {missing.length > 0 && (
        <div className="warn">
          Needs {missing.map((c) => c.label).join(', ')}.{' '}
          <button className="linkbtn" onClick={onOpenPlugins}>
            Add it under Plugins
          </button>
        </div>
      )}
      {plugin.notice && <p className="field-hint src-notice">{plugin.notice}</p>}

      {def.fields.map((f) => {
        const v = cfg[f.key] ?? f.default;
        const label = `${f.label}${f.required || f.default !== undefined || f.type === 'select' ? '' : ' (optional)'}`;
        if (f.type === 'boolean')
          return (
            <label key={f.key} className="toggle-row">
              <input type="checkbox" checked={!!v} onChange={(e) => setCfg(f.key, e.target.checked)} />
              <span>
                <b>{f.label}</b>
                {f.help && <span className="field-hint">{f.help}</span>}
              </span>
            </label>
          );
        return (
          <Field key={f.key} label={label} hint={f.help}>
            {f.type === 'select' ? (
              <select value={String(v ?? '')} onChange={(e) => setCfg(f.key, e.target.value)}>
                {optionList(f).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === 'list' ? (
              <ListInput value={v} placeholder={f.placeholder} onChange={(x) => setCfg(f.key, x)} />
            ) : f.type === 'textarea' ? (
              <textarea rows={3} className="mono" value={String(v ?? '')} placeholder={f.placeholder} onChange={(e) => setCfg(f.key, e.target.value)} />
            ) : (
              <input type={f.type === 'number' ? 'number' : 'text'} value={v == null ? '' : String(v)} placeholder={f.placeholder} onChange={(e) => setCfg(f.key, f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
            )}
          </Field>
        );
      })}

      <Field label="Save to dataset" hint="Items are kept and de-duplicated here across runs; several sources (and workflows) can feed one dataset. See it in Insights.">
        <DatasetInput value={d.dataset ?? ''} placeholder={workflowName} onChange={(v) => onChange({ dataset: v })} />
      </Field>
      <label className="toggle-row">
        <input type="checkbox" checked={d.onlyNew !== false} onChange={(e) => onChange({ onlyNew: e.target.checked })} />
        <span>
          <b>Pass on only new items</b>
          <span className="field-hint">The next step gets what wasn’t seen before. Off = everything fetched this run (useful for stats and trends).</span>
        </span>
      </label>
      <label className="toggle-row">
        <input type="checkbox" checked={!!d.stopIfEmpty} onChange={(e) => onChange({ stopIfEmpty: e.target.checked })} />
        <span>
          <b>Stop if nothing new</b>
          <span className="field-hint">Skip the following steps (no agent runs, no usage) when there’s nothing new.</span>
        </span>
      </label>
      <label className="toggle-row">
        <input type="checkbox" checked={!!d.continueOnError} onChange={(e) => onChange({ continueOnError: e.target.checked })} />
        <span>
          <b>Keep going if this source fails</b>
          <span className="field-hint">The step shows as failed, but the rest of the workflow continues without it.</span>
        </span>
      </label>
      <Field label="Max items per run">
        <input type="number" min={1} max={500} value={d.limit ?? 100} onChange={(e) => onChange({ limit: Number(e.target.value) || 100 })} />
      </Field>

      <div className="src-preview">
        <div className="src-preview-head">
          <span className="field-label">Preview</span>
          <button className="btn sm" onClick={runPreview} disabled={running}>
            {running ? 'Fetching…' : 'Fetch sample'}
          </button>
        </div>
        <p className="field-hint">Runs the source once with these settings. Nothing is saved; templates like {'{{trigger.payload}}'} aren’t filled in.</p>
        {preview && !preview.ok && <div className="warn">{preview.error}</div>}
        {preview?.ok && (
          <>
            <p className="muted small">
              {preview.count} item{preview.count === 1 ? '' : 's'}
              {preview.points ? `, ${preview.points} data points` : ''} in {(preview.ms / 1000).toFixed(1)}s{preview.note ? ` · ${preview.note}` : ''}
            </p>
            <ul className="src-items">
              {(preview.items ?? []).map((i) => (
                <li key={i.id}>
                  <div className="src-item-title">
                    {i.url ? (
                      <a href={i.url} target="_blank" rel="noreferrer">
                        {i.title || i.text?.slice(0, 90) || i.id}
                      </a>
                    ) : (
                      i.title || i.text?.slice(0, 90) || i.id
                    )}
                  </div>
                  <div className="src-item-meta">
                    {[i.kind, i.author, ago(i.publishedAt), i.metrics && Object.entries(i.metrics).filter(([, x]) => x != null).map(([k, x]) => `${k} ${x}`).join(' · ')].filter(Boolean).join(' · ')}
                  </div>
                  {i.title && i.text && <div className="src-item-text">{i.text.slice(0, 180)}</div>}
                </li>
              ))}
            </ul>
          </>
        )}
        {preview?.log?.map((l, i) => (
          <p key={i} className="field-hint">
            {l}
          </p>
        ))}
      </div>
    </>
  );
}

export function DatasetFields({ config: d, onChange, onOpenInsights }: { config: Record<string, any>; onChange: (patch: Record<string, any>) => void; onOpenInsights: (name: string) => void }) {
  return (
    <>
      <p className="muted small">
        Connect this to agents: drag from its bottom handle to an agent’s <b>top</b> handle. Connected agents get <code>dataset_stats</code>, <code>dataset_search</code> and{' '}
        <code>dataset_top</code> to analyse what your Sources collected. Sources fill a dataset by <b>name</b>.
      </p>
      <Field label="Dataset">
        <DatasetInput value={d.name ?? ''} placeholder="Brand" onChange={(v) => onChange({ name: v })} />
      </Field>
      {d.name?.trim() && (
        <button className="btn sm" onClick={() => onOpenInsights(d.name)}>
          Open in Insights
        </button>
      )}
    </>
  );
}

const INSIGHT_FIELDS: Array<{ key: InsightField; label: string; hint: string }> = [
  { key: 'sentiment', label: 'Sentiment', hint: '−1 negative … 1 positive' },
  { key: 'topics', label: 'Topics', hint: '1–4 short labels' },
  { key: 'relevance', label: 'Relevance', hint: '0–1, against your brief' },
  { key: 'entities', label: 'Entities', hint: 'brands, products, people' },
  { key: 'language', label: 'Language', hint: 'ISO code' },
  { key: 'summary', label: 'One-line summary', hint: 'in English' },
];

export function InsightFields({ config: d, workflowName, onChange }: { config: Record<string, any>; workflowName: string; onChange: (patch: Record<string, any>) => void }) {
  const fields: string[] = d.fields ?? [];
  const toggle = (k: string, on: boolean) => onChange({ fields: on ? [...fields, k] : fields.filter((f) => f !== k) });
  return (
    <>
      <p className="muted small">
        Labels items that haven’t been labelled yet, in batches of 25 per Claude call. Results show in Insights, and the output (<code>count</code>, <code>avgSentiment</code>,{' '}
        <code>negativeShare</code>, <code>topTopics</code>…) can drive a Condition, e.g. <code>output.negativeShare &gt; 0.3</code>.
      </p>
      <Field label="Dataset" hint="Empty = the dataset of the Source(s) before this step.">
        <DatasetInput value={d.dataset ?? ''} placeholder={`from the sources (or “${workflowName}”)`} onChange={(v) => onChange({ dataset: v })} />
      </Field>
      <div className="field">
        <span className="field-label">Extract</span>
        <div className="check-grid">
          {INSIGHT_FIELDS.map((f) => (
            <label key={f.key} className="check">
              <input type="checkbox" checked={fields.includes(f.key)} onChange={(e) => toggle(f.key, e.target.checked)} />
              <span>
                {f.label}
                <small>{f.hint}</small>
              </span>
            </label>
          ))}
        </div>
      </div>
      <Field label="Brief" hint="What you care about. Sentiment is measured toward it; relevance against it.">
        <textarea rows={2} value={d.brief ?? ''} placeholder="Mentions of Acme and its products. Sentiment toward Acme." onChange={(e) => onChange({ brief: e.target.value })} />
      </Field>
      <Field label="Custom fields" hint='One per line, "key: what to extract". Stored with each item.'>
        <textarea rows={2} className="mono" value={d.custom ?? ''} placeholder={'type: bug, feature request, praise or question\ncompetitor: competitor mentioned, if any'} onChange={(e) => onChange({ custom: e.target.value })} />
      </Field>
      <div className="row2">
        <Field label="Model" hint="haiku is fast and light on usage.">
          <input list="models" value={d.model ?? 'haiku'} onChange={(e) => onChange({ model: e.target.value })} />
        </Field>
        <Field label="Max items per run">
          <input type="number" min={1} max={500} value={d.maxItems ?? 100} onChange={(e) => onChange({ maxItems: Number(e.target.value) || 100 })} />
        </Field>
      </div>
      <label className="toggle-row">
        <input type="checkbox" checked={!!d.stopIfEmpty} onChange={(e) => onChange({ stopIfEmpty: e.target.checked })} />
        <span>
          <b>Stop if nothing new</b>
          <span className="field-hint">Skip the following steps when there was nothing to label.</span>
        </span>
      </label>
    </>
  );
}

/** Agent setting: which plugin tools it may call during its run. */
export function PluginToolsPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [tools, setTools] = useState<PluginTool[] | null>(null);
  useEffect(() => {
    void api.pluginTools().then(setTools).catch(() => setTools([]));
  }, []);
  if (!tools) return null;
  const unknown = value.filter((v) => !tools.some((t) => t.name === v));
  return (
    <div className="field">
      <span className="field-label">Plugin tools</span>
      {!tools.length && <span className="field-hint">No enabled plugin offers tools.</span>}
      <div className="check-grid">
        {tools.map((t) => (
          <label key={t.name} className="check" title={t.description}>
            <input type="checkbox" checked={value.includes(t.name)} onChange={(e) => onChange(e.target.checked ? [...value, t.name] : value.filter((x) => x !== t.name))} />
            <span>
              {t.icon} <code>{t.name}</code>
              <small>{t.description}</small>
            </span>
          </label>
        ))}
      </div>
      {unknown.length > 0 && <span className="field-hint warnish">Not available (plugin off or removed): {unknown.join(', ')}</span>}
      <span className="field-hint">Live lookups the agent can make while it works (they don’t count as tools above). Connect a Dataset for collected data.</span>
    </div>
  );
}
