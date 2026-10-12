// Shared package entry: Node is the only wrapper runtime. Native tools stay in the package.
import { spawnSync } from 'node:child_process';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostRid, readManifest, verifyRelease } from './verify-release.mjs';
const releaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function runAuthoring(tool, argv, { root = releaseRoot, rid = hostRid(), env = process.env, stdio = 'inherit' } = {}) {
  const manifest = readManifest(root);
  if (manifest.formatVersion !== 2) {
    const error = new Error('sdk_version_mismatch: authoring requires release manifest format 2');
    error.code = 'sdk_version_mismatch'; throw error;
  }
  verifyRelease({ root, rid });
  const ref = manifest.authoring.tools[tool]?.[rid];
  if (!ref) { const error = new Error(`BLOCKED_ENV: no packaged ${tool} for ${rid}`); error.code = 'BLOCKED_ENV'; throw error; }
  const binary = join(root, ref.entrypoint);
  // Resolve bundled dynamic libraries ahead of any host additions; never search PATH for a tool.
  const childEnv = { ...env };
  if (rid === 'linux-x64') childEnv.LD_LIBRARY_PATH = [dirname(binary), env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter);
  const result = spawnSync(binary, argv, { env: childEnv, stdio });
  if (result.error) { const error = new Error(`BLOCKED_ENV: cannot execute packaged ${tool}: ${result.error.message}`); error.code = 'BLOCKED_ENV'; throw error; }
  return result;
}
export function authoringCli(tool) {
  try {
    const result = runAuthoring(tool, process.argv.slice(2));
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.status;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code === 'BLOCKED_ENV' ? 2 : 1;
  }
}
