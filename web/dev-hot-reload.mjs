export function createBrowserSession({ session, info, apply, updateCss = () => {}, timeoutMs = 15000 }) {
  let state = 'running';
  let sequence = 0;
  let pending;
  let timer;
  let queuedBytes = 0;
  const queued = [];
  const documentId = globalThis.crypto.randomUUID();
  const refuse = (code, detail) => ({ ok: false, code, detail, state, sequence, session });
  const status = () => ({ ok: true, ...info(), documentId, state, sequence, session });
  const cancelTimer = () => clearTimeout(timer);
  const drain = () => {
    while (state === 'running' && queued.length) {
      const item = queued.shift();
      queuedBytes -= item.bytes;
      try { item.invoke(); } catch (error) { state = 'faulted'; throw error; }
    }
  };
  const deadline = () => {
    cancelTimer();
    timer = setTimeout(() => {
      if (state === 'prepared') { pending = undefined; state = 'running'; drain(); }
      else if (state === 'applied') state = 'faulted';
    }, timeoutMs);
  };
  return {
    status,
    run(invoke, bytes = 0) {
      if (state === 'running') return invoke();
      if (state === 'faulted') throw new Error('Development hot reload is faulted; restart is required.');
      if (queued.length >= 256 || queuedBytes + bytes > 1048576) {
        state = 'faulted'; cancelTimer();
        throw new Error('Development pause exceeded its ingress budget.');
      }
      queued.push({ invoke, bytes }); queuedBytes += bytes;
    },
    command(path, body) {
      if (path === '/status') return status();
      if (body?.session !== session) return refuse('session_mismatch', 'Development session differs.');
      if (path === '/css' && state === 'running') {
        if (typeof body.path !== 'string' || !/^\/[\w.-]+\.css$/.test(body.path)) return refuse('invalid_css', 'Expected a local stylesheet path.');
        updateCss(body.path);
        return { ok: true, state, session, sequence };
      }
      if (path === '/prepare') {
        if (state !== 'running' || body.sequence !== sequence + 1) return refuse('sequence_mismatch', 'Expected the next update while running.');
        if (!Array.isArray(body.updates) || body.updates.length > 64) return refuse('invalid_updates', 'Expected at most 64 module updates.');
        const modules = new Set(info().modules.map(module => module.mvid.toLowerCase()));
        const seen = new Set();
        for (const update of body.updates) {
          const id = update.moduleId?.toLowerCase();
          if (!modules.has(id) || seen.has(id)) return refuse('module_not_loaded', 'Missing or duplicate loaded module identity.');
          seen.add(id);
        }
        pending = structuredClone(body); state = 'prepared'; deadline();
        return { ok: true, state, sequence: body.sequence, session, moduleIds: [...seen] };
      }
      if (!pending || pending.sequence !== body?.sequence) return refuse('sequence_mismatch', 'No matching pending update.');
      if (path === '/abort' && state === 'prepared') {
        state = 'running'; pending = undefined; cancelTimer(); drain();
        return { ok: true, state, sequence, session };
      }
      if (path === '/apply' && state === 'prepared') {
        try {
          const entries = pending.updates.length ? apply(pending.updates) : [];
          if (entries.some(entry => entry.severity === 3 || entry.severity === 2)) throw new Error('The SDK reported an apply failure.');
          sequence = pending.sequence; state = 'applied'; deadline();
          return { ok: true, state, sequence, session };
        } catch {
          state = 'faulted'; cancelTimer();
          return refuse('apply_failed', 'Code application failed; rollback is unavailable.');
        }
      }
      if (path === '/resume' && state === 'applied') {
        state = 'running'; pending = undefined; cancelTimer(); drain();
        return { ok: true, state, sequence, session };
      }
      return refuse('invalid_state', 'Operation is not allowed in the current state.');
    },
    close() { cancelTimer(); if (state !== 'running') state = 'faulted'; },
  };
}

export async function connectDevelopmentBridge({ api, sdk, config }) {
  if (!sdk?.GetApplyUpdateCapabilities()) throw new Error('The official browser Hot Reload agent is not initialized.');
  const session = createBrowserSession({
    session: config.session,
    info: () => ({ modules: JSON.parse(api.DevLoadedModules()), capabilities: sdk.GetApplyUpdateCapabilities().split(' ') }),
    apply: updates => JSON.parse(sdk.ApplyHotReloadDeltas(JSON.stringify(updates), 2) ?? '[]'),
    updateCss: path => {
      for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
        const url = new URL(link.href);
        if (url.origin === location.origin && url.pathname === path) {
          url.searchParams.set('devRevision', crypto.randomUUID());
          link.href = url.href;
        }
      }
    },
    timeoutMs: config.timeoutMs,
  });
  const controller = new AbortController();
  const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
  const poll = async () => {
    while (!controller.signal.aborted) {
      const response = await fetch('/dev/browser/poll', { headers, signal: controller.signal });
      if (response.status === 204) continue;
      if (!response.ok) throw new Error('Development bridge rejected the browser.');
      const request = await response.json();
      const result = session.command(request.path, request.body);
      const ack = await fetch('/dev/browser/result', { method: 'POST', headers, body: JSON.stringify({ id: request.id, result }), signal: controller.signal });
      if (!ack.ok) throw new Error('Development bridge could not acknowledge the update.');
    }
  };
  poll().catch(error => { session.close(); console.error('Development hot reload stopped:', error.message); });
  return session;
}
