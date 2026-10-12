import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const snippet = text => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
const gracefulProcesses = new WeakMap();

// Credential values must not enter command metadata. Only the log projection
// changes: the child always receives the caller's original argument array.
function loggedArguments(args) {
  let secretValue = false;
  return args.map(arg => {
    if (secretValue) {
      secretValue = false;
      return '<redacted>';
    }
    const option = /^--([^=]+)(=|$)/.exec(String(arg));
    const name = option?.[1].replace(/[-_]/g, '');
    if (!name || !/(?:ticket|credential|token|password|passwd|secret|apikey|privatekey|signingkey)$/i.test(name)) return arg;
    if (option[2] === '=') return `${String(arg).slice(0, option[0].length)}<redacted>`;
    secretValue = true;
    return arg;
  });
}

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
  if (log) writeFileSync(log, `$ ${JSON.stringify([executable, ...loggedArguments(args)])}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (!log && result.stdout) process.stdout.write(result.stdout);
    throw attributeCommandFailure(executable, args, result, { log });
  }
  return result.stdout;
}

// Opt-in pairs Windows console startup with stopLogged's Ctrl+C request.
// Ordinary children retain the existing spawn options and cleanup behavior.
export function startLogged(executable, args, { cwd, env = process.env, log, gracefulShutdown = false }) {
  writeFileSync(log, `$ ${JSON.stringify([executable, ...loggedArguments(args)])}\n`);
  const paired = gracefulShutdown === true;
  const platform = process.platform;
  const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    ...(paired && platform === 'win32' ? { detached: true } : {}) });
  const state = { child, stdout: '', closed: false, code: null, signal: null, error: null };
  if (paired) gracefulProcesses.set(state, { platform, log, child, pid: child.pid });
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

// Requests an orderly stop and confirms close/exit 0 within one shared budget.
// Success is a process result; callers still verify their domain's flush and
// wire-close evidence. Strong cleanup remains a separate failure path.
export async function stopLogged(state, timeoutMs = 10000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) {
    throw new Error('stopLogged timeoutMs must be a positive timer-safe integer');
  }
  const owned = gracefulProcesses.get(state);
  if (!owned) throw new Error('stopLogged requires the state from startLogged with gracefulShutdown: true');
  if (state.error) throw state.error;
  if (state.child !== owned.child || state.child.pid !== owned.pid || !Number.isSafeInteger(owned.pid) || owned.pid <= 0) {
    throw new Error('stopLogged state no longer identifies its paired child and PID');
  }
  const started = performance.now();
  // An exited child can retain open inherited pipes; await close without
  // targeting its numeric PID again after ChildProcess reports termination.
  if (!state.closed && state.child.exitCode === null && state.child.signalCode === null) {
    if (owned.platform === 'win32') {
      // Group 0 broadcasts inside the attached console: only paired startup
      // permits this request, never an arbitrary PID or an ordinary child.
      const script = [
        "$api = Add-Type -PassThru -Name LumioConsoleCtrl -Namespace Lumio -MemberDefinition @'",
        '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();',
        '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);',
        '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);',
        '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint evt, uint group);',
        '[DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList([Out] uint[] processList, uint count);',
        "'@",
        '[void]$api::FreeConsole()',
        'if (-not $api::AttachConsole([uint32]$env:LUMIO_DS_INTERRUPT_PID)) { exit 1 }',
        'if (-not $api::SetConsoleCtrlHandler([IntPtr]::Zero, $true)) { exit 3 }',
        '$members = [uint32[]]::new(2)',
        '$count = $api::GetConsoleProcessList($members, 2)',
        'if ($count -ne 2 -or -not ($members -contains [uint32]$PID) -or -not ($members -contains [uint32]$env:LUMIO_DS_INTERRUPT_PID)) { [Console]::Error.WriteLine("console ownership check failed: count=$count"); exit 4 }',
        'if (-not $api::GenerateConsoleCtrlEvent(0, 0)) { exit 2 }',
        'Start-Sleep -Seconds 1',
        '[void]$api::FreeConsole()',
      ].join('\n');
      const args = ['-NoProfile', '-NonInteractive', '-Command', script];
      const helper = spawnSync('powershell', args, {
        env: { ...process.env, LUMIO_DS_INTERRUPT_PID: String(state.child.pid) },
        encoding: 'utf8', timeout: Math.min(timeoutMs, 10000),
      });
      appendFileSync(owned.log, `$ powershell (graceful shutdown pid=${state.child.pid})\n${helper.stdout ?? ''}${helper.stderr ?? ''}${helper.error ? `${helper.error.message}\n` : ''}`);
      if (helper.error) throw helper.error;
      if (helper.status !== 0 || helper.signal) {
        const error = attributeCommandFailure('powershell', args, helper, { log: owned.log });
        if (helper.signal) error.message += ` signal=${helper.signal}`;
        throw error;
      }
    } else if (!state.child.kill('SIGTERM')) {
      throw new Error(`Process ${state.child.pid} did not accept the graceful SIGTERM request`);
    }
  }
  const remaining = timeoutMs - (performance.now() - started);
  if (remaining <= 0) throw new Error(`Process ${state.child.pid} did not close within ${timeoutMs}ms.`);
  const result = await waitExit(state, Math.ceil(remaining));
  if (!result.closed || result.signal) throw new Error(`Process ${state.child.pid} did not close normally: signal=${result.signal}`);
  return result;
}

export async function forceCleanup(state) {
  if (!state || state.closed) return;
  state.child.kill('SIGKILL');
  // Always reap the child, but a forced kill is never accepted as passing evidence.
  await Promise.race([state.done, new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); })]);
}
