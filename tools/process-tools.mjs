import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const snippet = text => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);

export function inferFailureSurface(executable, args = [], combined = '') {
  const script = args.map(arg => String(arg)).find(arg => arg.endsWith('.mjs') || arg.endsWith('.json')) ?? '';
  const file = basename(script);
  const text = combined ?? '';
  // Test output contains fixture diagnostics and passing test names, not just failures.
  if (/^node(?:\.exe)?$/.test(basename(executable)) && args.includes('--test')) {
    return { surface: 'test', code: 'test_failed' };
  }
  if (/CS1705/.test(text)) return { surface: 'compile', code: 'CS1705' };
  // Prefer `error CSxxxx` over the first CS code in the log. GenerateDocumentationFile
  // emits hundreds of `warning CS1591` lines; matching those first hid Client CS0104
  // on Engine integration (run 34590478369).
  if (/error CS\d{4}/.test(text) || /error MSB/.test(text) || /CS\d{4}/.test(text)) {
    const code = /error (CS\d{4})/.exec(text)?.[1]
      ?? /error (MSB\d+)/.exec(text)?.[1]
      ?? /CS\d{4}/.exec(text)?.[0]
      ?? /MSB\d+/.exec(text)?.[0]
      ?? 'compile_failed';
    return { surface: 'compile', code };
  }
  if (/not valid JSON|Unexpected token|Unexpected end of JSON|JSON\.parse/.test(text)) {
    return { surface: 'format', code: 'invalid_json' };
  }
  if (/contract shape invalid|has invalid type spec|required must be/.test(text)) {
    return { surface: 'format', code: 'invalid_shape' };
  }
  if (file === 'verify-wire.mjs' || /engine\/wire\/.+\.json$/.test(script)) {
    if (/FAIL/.test(text) || /verify-wire: FAILED/.test(text)) {
      return { surface: 'contract', code: 'contract_invalid' };
    }
    return { surface: 'contract', code: 'contract_failed' };
  }
  if (/BLOCKED_ENV/.test(text) || /hostfxr not found/.test(text)) return { surface: 'env', code: 'BLOCKED_ENV' };
  if (/missing_native|Native output not found|LUMIO_NATIVE/.test(text)) return { surface: 'native', code: 'missing_native' };
  if (/missing_contract/.test(text)) return { surface: 'contract', code: 'missing_contract' };
  if (executable === 'dotnet' && args.includes('test')) return { surface: 'test', code: 'test_failed' };
  if (executable === 'cargo' && args.includes('test')) return { surface: 'test', code: 'test_failed' };
  if (executable === 'dotnet' || executable === 'cargo') return { surface: 'compile', code: 'exit_nonzero' };
  return { surface: 'process', code: 'exit_nonzero' };
}

export function attributeCommandFailure(executable, args, result, { log } = {}) {
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const { surface, code } = inferFailureSurface(executable, args, combined);
  const failedTests = surface === 'test'
    ? combined.split(/\r?\n/).filter(line => /^\s*not ok\b|^\s*location:|^✖/.test(line)).join(' ')
    : '';
  const error = new Error(
    `[${surface}/${code}] ${executable} exited ${result.status ?? result.signal}. ${snippet(failedTests || combined)}${log ? ` log=${log}` : ''}`,
  );
  error.stdout = result.stdout ?? '';
  error.stderr = result.stderr ?? '';
  error.surface = surface;
  error.code = code;
  error.status = result.status ?? null;
  error.signal = result.signal ?? null;
  error.log = log ?? null;
  return error;
}

export function command(executable, args, { cwd, env = process.env, log } = {}) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (log) writeFileSync(log, `$ ${JSON.stringify([executable, ...args])}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (!log && result.stdout) process.stdout.write(result.stdout);
    throw attributeCommandFailure(executable, args, result, { log });
  }
  return result.stdout;
}

export function startLogged(executable, args, { cwd, env = process.env, log }) {
  writeFileSync(log, `$ ${JSON.stringify([executable, ...args])}\n`);
  const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const state = { child, stdout: '', closed: false, code: null, signal: null, error: null };
  child.stdin.on('error', () => {}); // An exited child is handled through its exit/error state.
  child.stdout.on('data', bytes => {
    state.stdout = (state.stdout + bytes.toString()).slice(-1024 * 1024);
    appendFileSync(log, bytes);
  });
  child.stderr.on('data', bytes => appendFileSync(log, bytes));
  child.on('error', error => { state.error = error; });
  state.done = new Promise(resolve => child.once('close', (code, signal) => {
    Object.assign(state, { closed: true, code, signal });
    resolve(state);
  }));
  return state;
}

export function assertAlive(state) {
  if (state.error) throw state.error;
  if (state.closed) throw new Error(`Process ${state.child.pid} exited before proof completed: code=${state.code}, signal=${state.signal}`);
}

export function waitExit(state, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Process ${state.child.pid} did not exit within ${timeoutMs}ms.`)), timeoutMs);
    state.done.then(result => {
      clearTimeout(timer);
      if (result.error) reject(result.error);
      else if (result.code !== 0) reject(new Error(`Process ${result.child.pid} exited ${result.code ?? result.signal}.`));
      else resolve(result);
    });
  });
}

export async function forceCleanup(state) {
  if (!state || state.closed) return;
  state.child.kill('SIGKILL');
  // Always reap the child, but a forced kill is never accepted as passing evidence.
  await Promise.race([state.done, new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); })]);
}
