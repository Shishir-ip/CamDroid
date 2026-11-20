// Lowest-latency MJPEG client: parses the multipart stream incrementally and
// emits complete JPEG frames as soon as the EOI marker arrives.

function indexOfPair(buf, b0, b1, from) {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === b0 && buf[i + 1] === b1) return i;
  }
  return -1;
}

function concat(a, b) {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * startStream(url, { onFrame(jpegBytes), onOpen(), onError(err) }, abortSignal)
 * Resolves when the stream ends; rejects on network error.
 */
export async function startStream(url, hooks, signal) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) ctrl.abort();
  let watchdog;
  const resetTimeout = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(abort, 8000);
  };
  let reader;
  let buf = new Uint8Array(0);
  resetTimeout();
  try {
    const resp = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
    reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = concat(buf, value);
      let start = indexOfPair(buf, 0xff, 0xd8, 0);
      while (start >= 0) {
        const end = indexOfPair(buf, 0xff, 0xd9, start + 2);
        if (end < 0) {
          if (start > 0) buf = buf.slice(start);
          break;
        }
        const jpeg = buf.slice(start, end + 2);
        buf = buf.slice(end + 2);
        resetTimeout();
        hooks.onOpen?.();
        hooks.onFrame?.(jpeg);
        start = indexOfPair(buf, 0xff, 0xd8, 0);
      }
      // Guard against unbounded growth on corrupt streams.
      if (buf.length > 8 * 1024 * 1024) buf = new Uint8Array(0);
    }
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', abort);
    try { await reader?.cancel(); } catch {}
    try { reader?.releaseLock(); } catch {}
  }
}

export async function fetchInfo(host, port, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://${host}:${port}/info`, { signal: ctrl.signal, cache: 'no-store' });
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

export async function sendSet(host, port, obj) {
  try {
    await fetch(`http://${host}:${port}/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj)
    });
  } catch {}
}