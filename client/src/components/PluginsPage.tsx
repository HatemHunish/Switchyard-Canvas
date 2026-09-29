import { useState } from 'react';
import { api, ApiError, type PluginInfo } from '../api';
import { refreshPlugins, usePlugins } from '../lib/plugins';

const EXAMPLE = `// ~/.agent-canvas/plugins/my-source/plugin.json
{
  "id": "my-source", "name": "My source", "version": "1.0.0", "icon": "🧩",
  "credentials": [{ "key": "token", "label": "API token" }],
  "sources": [{ "id": "latest", "title": "Latest records",
    "fields": [{ "key": "query", "label": "Search", "type": "text", "required": true }] }],
  "tools": [{ "name": "my_lookup", "description": "Look something up",
    "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } } } }]
}

// ~/.agent-canvas/plugins/my-source/index.js
module.exports = {
  sources: {
    async latest(config, ctx) {
      const token = await ctx.secret('token');
      const data = await ctx.json(\`https://api.example.com/search?q=\${encodeURIComponent(config.query)}\`,
        { headers: { authorization: \`Bearer \${token}\` } });
      return { items: data.results.map((r) => ({
        id: r.id, kind: 'post', title: r.title, text: r.body, url: r.url,
        author: r.user, publishedAt: r.created_at, metrics: { likes: r.likes } })) };
    },
  },
  tools: { async my_lookup(args, ctx) { return ctx.json('https://api.example.com/x?q=' + args.q); } },
  async test(ctx) { return 'Connected'; },
};`;

function PluginCard({ p, notify }: { p: PluginInfo; notify: (m: string, k?: 'ok' | 'err') => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [more, setMore] = useState(false);
  const creds = p.credentials ?? [];
  const missing = creds.filter((c) => !c.optional && !p.credentialsSet[c.key]);
  const dirty = Object.values(values).some((v) => v.trim());

  const toggle = async () => {
    if (!p.enabled && !p.builtin && !confirm(`“${p.name}” is a plugin from your plugins folder. It runs code on this Mac with your permissions. Only enable plugins you trust.`)) return;
    try {
      await api.setPluginEnabled(p.id, !p.enabled);
      await refreshPlugins();
    } catch (err) {
      notify((err as ApiError).message, 'err');
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.savePluginCredentials(p.id, Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())));
      setValues({});
      await refreshPlugins();
      notify(`${p.name}: saved to the Keychain`, 'ok');
    } catch (err) {
      notify((err as ApiError).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key: string, label: string) => {
    if (!confirm(`Remove the saved ${label}?`)) return;
    await api.savePluginCredentials(p.id, { [key]: '' });
    await refreshPlugins();
  };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      setTest(await api.testPlugin(p.id));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`plug ${p.enabled ? '' : 'off'}`}>
      <header className="plug-head">
        <span className="plug-icon" aria-hidden>
          {p.icon ?? '🧩'}
        </span>
        <div className="plug-title">
          <b>{p.name}</b>
          <span className="muted small">
            v{p.version} · {p.builtin ? 'built in' : 'from plugins folder'}
          </span>
        </div>
        <label className={`switch ${p.enabled ? 'on' : ''}`} title={p.enabled ? 'Turn off' : 'Turn on'}>
          <input type="checkbox" checked={p.enabled} onChange={toggle} aria-label={`${p.name} enabled`} />
          <span className="track">
            <span className="thumb" />
          </span>
          {p.enabled ? 'On' : 'Off'}
        </label>
      </header>
      {p.description && <p className="plug-desc">{p.description}</p>}
      {p.error && <div className="warn">{p.error}</div>}
      <div className="plug-caps">
        {(p.sources ?? []).map((s) => (
          <span key={s.id} className="chip-sm" title={s.hint}>
            📥 {s.title}
          </span>
        ))}
        {(p.tools ?? []).map((t) => (
          <span key={t.name} className="chip-sm tool" title={t.description}>
            🔧 {t.name}
          </span>
        ))}
      </div>
      {p.notice && (
        <p className={`plug-notice ${more ? 'open' : ''}`} onClick={() => setMore(!more)} title={more ? '' : 'Show more'}>
          {p.notice}
        </p>
      )}
      {creds.length > 0 && (
        <div className="plug-creds">
          {creds.map((c) => (
            <label key={c.key} className="field">
              <span className="field-label">
                {c.label}
                {c.optional ? ' (optional)' : ''}
                {p.credentialsSet[c.key] && <span className="saved"> · saved in Keychain</span>}
              </span>
              <span className="plug-cred-row">
                <input
                  type="password"
                  autoComplete="off"
                  value={values[c.key] ?? ''}
                  placeholder={p.credentialsSet[c.key] ? '•••••••• (enter a new value to replace)' : c.placeholder || ''}
                  onChange={(e) => setValues({ ...values, [c.key]: e.target.value })}
                />
                {p.credentialsSet[c.key] && (
                  <button className="linkbtn danger" onClick={() => void remove(c.key, c.label)} aria-label={`Remove ${c.label}`}>
                    Remove
                  </button>
                )}
              </span>
              {c.help && (
                <span className="field-hint">
                  {/^https?:\/\//.test(c.help) ? (
                    <a href={c.help} target="_blank" rel="noreferrer">
                      Where to get it
                    </a>
                  ) : (
                    c.help
                  )}
                </span>
              )}
            </label>
          ))}
        </div>
      )}
      <footer className="plug-foot">
        {missing.length > 0 && <span className="warnish small">Needs {missing.map((c) => c.label).join(', ')}</span>}
        {p.homepage && (
          <a className="small" href={p.homepage} target="_blank" rel="noreferrer">
            Docs ↗
          </a>
        )}
        <span className="spacer" />
        {dirty && (
          <button className="btn primary sm" onClick={save} disabled={busy}>
            Save
          </button>
        )}
        <button className="btn sm" onClick={runTest} disabled={busy || !p.enabled}>
          {busy && !dirty ? 'Testing…' : 'Test connection'}
        </button>
      </footer>
      {test && (
        <p className={`plug-test ${test.ok ? 'ok' : 'bad'}`} role="status">
          {test.ok ? '✓' : '✕'} {test.text}
        </p>
      )}
    </article>
  );
}

/** Installed plugins: turn them on/off, add keys, test, and how to write one. */
export function PluginsPage({ notify }: { notify: (m: string, k?: 'ok' | 'err') => void }) {
  const catalog = usePlugins();
  const [showHow, setShowHow] = useState(false);
  const [filter, setFilter] = useState('');
  if (!catalog) return <div className="dash-loading muted">Loading plugins…</div>;
  const f = filter.trim().toLowerCase();
  const shown = catalog.plugins.filter((p) => !f || `${p.name} ${p.description} ${(p.sources ?? []).map((s) => s.title).join(' ')}`.toLowerCase().includes(f));

  return (
    <div className="dash plugins-page">
      <div className="plug-intro">
        <div>
          <h1>Plugins</h1>
          <p className="muted">
            Plugins add <b>Sources</b> that collect data on a schedule without using your Claude subscription, <b>tools</b> agents can call, and <b>Insights</b> panels. Keys are stored in
            the macOS Keychain, never in workflow files.
          </p>
        </div>
        <div className="plug-actions">
          <input className="filter-search" placeholder="Filter plugins…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter plugins" />
          <button className="btn sm" onClick={() => void api.openPluginsFolder()}>
            Open plugins folder
          </button>
          <button
            className="btn sm"
            onClick={async () => {
              await api.reloadPlugins();
              await refreshPlugins();
              notify('Plugins reloaded', 'ok');
            }}
          >
            Reload
          </button>
          <button className="btn ghost sm" onClick={() => setShowHow(!showHow)} aria-expanded={showHow}>
            Write your own
          </button>
        </div>
      </div>

      {catalog.failures.map((x) => (
        <div key={x.dir} className="warn">
          Couldn’t load <code>{x.dir}</code>: {x.error}
        </div>
      ))}

      {showHow && (
        <section className="card plug-how">
          <p>
            A plugin is a folder in <code>{catalog.folder}</code> with a <code>plugin.json</code> and an <code>index.js</code>. Sources return <b>items</b> (posts, comments, articles,
            reviews…) and optionally <b>points</b> (a number over time, like followers). The app de-duplicates, stores and charts them. <code>ctx</code> gives you <code>fetch</code>/
            <code>json</code>/<code>text</code>/<code>xml</code> (with timeouts, cancel and rate-limit handling), <code>secret(key)</code>, <code>log()</code> and a per-node <code>state</code>{' '}
            object for cursors. Click Reload after changes; new folder plugins start turned off. Full reference: <code>docs/plugins.md</code>.
          </p>
          <pre className="mono">{EXAMPLE}</pre>
        </section>
      )}

      <div className="plug-grid">
        {shown.map((p) => (
          <PluginCard key={p.id} p={p} notify={notify} />
        ))}
      </div>
    </div>
  );
}
