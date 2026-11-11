import { configure, createSession, releaseSession, upscale, type Session } from './engine';
import { Aborted } from './pixels';

let session: Session | null = null;
let ctl: AbortController | null = null;
const post = (m: unknown, tr: Transferable[] = []) => (self as unknown as Worker).postMessage(m, tr);

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'configure') {
      configure(m.wasmPaths, m.threads);
    } else if (m.type === 'load') {
      await releaseSession(session);
      session = null;
      session = await createSession(m.buf, m.gpu);
      post({ type: 'loaded', id: m.id, ep: session.ep });
    } else if (m.type === 'abort') {
      ctl?.abort();
    } else if (m.type === 'upscale') {
      if (!session) throw new Error('No model loaded');
      ctl = new AbortController();
      const out = await upscale(session, m.src, m.nativeScale, m.passes, m.downscale, m.tile, (pass, done) => post({ type: 'tile', id: m.id, pass, done }), ctl.signal);
      post({ type: 'result', id: m.id, out }, [out.data.buffer]);
    }
  } catch (err) {
    post({ type: 'error', id: m.id, aborted: err instanceof Aborted, message: String((err as Error)?.message ?? err) });
  }
};
