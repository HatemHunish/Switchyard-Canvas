import { useState } from 'react';
import { friendly } from '../lib/plain';

/** Ask the app shell to go somewhere (plugins page, settings, setup) from deep inside a component. */
export const navigateTo = (to: 'plugins' | 'settings' | 'setup') => window.dispatchEvent(new CustomEvent('ac:navigate', { detail: to }));

const FIX_LABEL = { plugins: 'Open Plugins', settings: 'Open Settings', login: 'Connect Claude', folder: '', retry: '' } as const;

/** A plain sentence people can act on, with the raw error one click away. */
export function FriendlyError({ error }: { error: string }) {
  const [details, setDetails] = useState(false);
  const f = friendly(error);
  if (!f) return null;
  const fixLabel = f.fix ? FIX_LABEL[f.fix] : '';
  return (
    <div className="err friendly">
      <div>{f.text}</div>
      <div className="friendly-actions">
        {fixLabel && (
          <button className="btn sm" onClick={() => navigateTo(f.fix === 'login' ? 'setup' : (f.fix as 'plugins' | 'settings'))}>
            {fixLabel}
          </button>
        )}
        {f.text !== error && (
          <button className="linkbtn small" onClick={() => setDetails(!details)} aria-expanded={details}>
            {details ? 'Hide details' : 'Details'}
          </button>
        )}
      </div>
      {details && <pre className="friendly-raw">{error}</pre>}
    </div>
  );
}
