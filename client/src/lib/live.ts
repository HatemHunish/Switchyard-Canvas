import type { BusEvent } from '../types';

type Listener = (e: BusEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;

/** One shared SSE connection for the whole app; EventSource reconnects on its own. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  if (!source) {
    source = new EventSource('/api/events');
    source.onmessage = (m) => {
      let event: BusEvent;
      try {
        event = JSON.parse(m.data);
      } catch {
        return;
      }
      listeners.forEach((l) => l(event));
    };
  }
  return () => {
    listeners.delete(fn);
  };
}
