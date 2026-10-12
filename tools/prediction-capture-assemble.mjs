// Offline assembly of closed, immutable Host parts. See assembleCapture's contract below.
import { open, lstat, mkdir, link, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { analyzeCapture, parseCaptureJson, u64, LIMIT_NAMES, loadCaptureLimits } from './prediction-capture.mjs';
import { isCliEntry } from './entry-guard.mjs';

function check(ok, message) { if (!ok) throw new Error(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.length > 0; }
function exact(value, required, optional = []) {
  check(object(value), 'expected metadata object');
  for (const key of required) check(Object.hasOwn(value, key), `missing metadata: ${key}`);
  for (const key of Object.keys(value)) check(required.includes(key) || optional.includes(key), `extra metadata: ${key}`);
}
function meter(limits) {
  exact(limits, LIMIT_NAMES);
  for (const name of LIMIT_NAMES) check(Number.isSafeInteger(limits[name]) && limits[name] > 0, `invalid limit: ${name}`);
  let used = 0;
  return { charge(n = 1) { check(Number.isSafeInteger(n) && n >= 0 && n <= limits.maxWork - used, 'work limit exceeded'); used += n; }, get used() { return used; } };
}

// Caller-supplied inputs name their own root: the operator typed that pathname, so a
// symlinked ancestor of it (macOS's /var -> /private/var, a junctioned checkout) is not
// an escape and is resolved once instead of rejected. Names declared inside a part
// manifest are untrusted data: they are joined to that resolved root, and every
// component below the root must be a real directory/file, so no symlink or junction can
// carry a capture out of its own directory. Closed immutable inputs and a private output
// parent are still required: portable Node cannot exclude hostile concurrent directory
// replacement (openat is unavailable).
async function rootPath(path, directory = false) {
  const real = await realpath(resolve(path)); const stat = await lstat(real);
  check(directory ? stat.isDirectory() : stat.isFile(), 'not a regular file/directory');
  return real;
}
// `root` is already resolved; `name` is manifest data, so reject anything but a plain
// relative name and then walk it component by component below the root.
async function containedPath(root, name) {
  check(text(name) && !name.includes('\\') && !name.includes(':') && !name.includes('\0') &&
    name.split('/').every(p => p !== '' && p !== '.' && p !== '..'), 'unsafe relative path');
  const parts = name.split('/'); let cursor = root;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]); const stat = await lstat(cursor);
    check(!stat.isSymbolicLink(), 'symlink path rejected');
    check(i === parts.length - 1 ? stat.isFile() : stat.isDirectory(), 'not a regular file/directory');
  }
  return cursor;
}
async function readBounded(path, bound, work) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    check(stat.isFile() && Number.isSafeInteger(stat.size) && stat.size <= bound, 'file byte limit exceeded');
    work.charge(stat.size + 1); // allocation before bounded read, including growth sentinel
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < bytes.length) {
      work.charge(bytes.length - offset);
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    check(offset === stat.size, 'file changed while reading');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
function hash(bytes, work) { work.charge(bytes.length); return createHash('sha256').update(bytes).digest('hex'); }
function json(bytes, work) {
  // Parser scans/string slices can revisit suffixes; this conservative quadratic
  // reservation covers its implementation, not just the number of parsed nodes.
  work.charge(bytes.length * bytes.length + bytes.length * 4);
  return parseCaptureJson(bytes, work);
}
function serialize(value, bound, work) {
  // Preflight a conservative UTF-8/escape upper bound before stringify allocates.
  let allowance = 0;
  function visit(v) {
    work.charge();
    if (typeof v === 'string') allowance += 6 * v.length + 2;
    else if (v === null || typeof v !== 'object') allowance += 32;
    else {
      allowance += 2;
      for (const key of Object.keys(v)) { work.charge(); allowance += 6 * key.length + 4; visit(v[key]); }
    }
    check(Number.isSafeInteger(allowance) && allowance <= bound, 'manifest serialization reservation exceeded');
  }
  visit(value); work.charge(allowance * 3);
  return Buffer.from(JSON.stringify(value));
}
async function writeExclusive(path, bytes, work) {
  work.charge(bytes.length);
  const handle = await open(path, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/**
 * assembleCapture({ clientManifest, authorityManifest, outputDirectory, limits,
 *                   metadataPath? }) -> { manifestPath, analysis, work }.
 * All seven analyzer limits are required. maxFiles/maxTotalBytes also cover
 * retained manifests, association evidence and the staging manifest. maxWork
 * charges bytes, parsing, object visits and conservative allocation reservations;
 * it is deliberately stricter than analyzer work. It is not an exact RSS bound
 * (V8, crypto, filesystem/OS internals excluded). No network evidence is fetched.
 * Metadata: { windowId, mapping, evidence:[{id,path,bytes,sha256}] }; mapping
 * evidence/revisions.evidence reference these IDs. Evidence paths are relative
 * to metadataPath. Original embedded source evidence remains in retained parts.
 */
export async function assembleCapture({ clientManifest, authorityManifest, outputDirectory, limits, metadataPath }) {
  const work = meter(limits);
  let admittedBytes = 0; let admittedFiles = 0; let admittedRecords = 0;
  function admit(bytes, records = 0) {
    check(Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= limits.maxTotalBytes - admittedBytes, 'aggregate byte limit exceeded');
    check(Number.isSafeInteger(records) && records >= 0 && records <= limits.maxRecords - admittedRecords, 'aggregate record limit exceeded');
    check(admittedFiles < limits.maxFiles, 'aggregate file limit exceeded');
    admittedBytes += bytes; admittedRecords += records; admittedFiles++;
  }
  const retained = []; const files = []; const ids = new Set(); const sourcePaths = new Set();
  const parts = [];
  for (const [role, path] of [['client', clientManifest], ['authority', authorityManifest]]) {
    work.charge();
    const root = await rootPath(path);
    const bytes = await readBounded(root, Math.min(limits.maxManifestBytes, limits.maxTotalBytes - admittedBytes), work);
    admit(bytes.length);
    const manifest = json(bytes, work);
    check(manifest.format === 'lumio-prediction-capture' && manifest.version === 1 && typeof manifest.complete === 'boolean', 'invalid part manifest');
    check(object(manifest.identity) && text(manifest.identity.captureId), 'missing capture identity');
    check(Array.isArray(manifest.files) && Array.isArray(manifest.windows) && Array.isArray(manifest.nativeStreams), 'missing part arrays');
    check(role === 'client' ? manifest.windows.length === 1 && manifest.nativeStreams.length === 0 : manifest.windows.length === 0 && manifest.nativeStreams.length === 1, 'expected one managed window and Native-only authority part');
    const name = `${role}-manifest.json`;
    retained.push({ path: name, bytes });
    parts.push({ role, manifest, base: dirname(root), path: name, sha256: hash(bytes, work) });
  }
  check(parts[0].manifest.identity.captureId !== parts[1].manifest.identity.captureId, 'duplicate capture identity');
  const window = parts[0].manifest.windows[0]; const native = parts[1].manifest.nativeStreams[0];
  u64(window.windowId); u64(native.worldGeneration);
  for (const id of [window.executionStreamId, window.causalStreamId, native.id]) {
    check(text(id) && !ids.has(id), 'duplicate or missing stream identity'); ids.add(id);
  }
  check(object(native.start) && object(native.final), 'missing Native status');
  for (const status of ['executionStart', 'executionFinal', 'causalStart', 'causalFinal']) check(object(window[status]), 'missing managed status');
  let complete = parts.every(p => p.manifest.complete);
  const counts = new Map(); let nativeSequence = u64(native.start.NextSequence);
  let nativePublication = u64(native.start.PhysicalPublicationOrdinal);
  for (const part of parts) {
    for (const file of part.manifest.files) {
      work.charge();
      const expectedKind = file.streamId === window.executionStreamId ? 'execution' : file.streamId === window.causalStreamId ? 'causal' : file.streamId === native.id ? 'native' : null;
      check(file.kind === expectedKind && (part.role === 'authority') === (file.kind === 'native'), 'undeclared or conflicting stream');
      const size = u64(file.bytes); const count = u64(file.records);
      check(size <= BigInt(limits.maxFileBytes) && size <= BigInt(limits.maxTotalBytes - admittedBytes), 'file byte limit exceeded');
      check(count <= BigInt(limits.maxRecords - admittedRecords), 'aggregate record limit exceeded');
      admit(Number(size), Number(count));
      const path = await containedPath(part.base, file.path); const absolute = path.toLowerCase();
      check(!sourcePaths.has(absolute), 'duplicate source file'); sourcePaths.add(absolute);
      const bytes = await readBounded(path, Number(size), work);
      check(bytes.length === Number(size) && hash(bytes, work) === file.sha256, 'file integrity mismatch');
      work.charge(bytes.length); let start = 0; let records = 0;
      for (let end = 0; end < bytes.length; end++) {
        check(end - start < limits.maxLineBytes, 'line limit exceeded');
        if (bytes[end] !== 10) continue;
        check(end > start && records < Number(count), 'record count integrity mismatch');
        const row = json(bytes.subarray(start, end), work); records++; start = end + 1;
        if (file.kind === 'native') {
          check(row.WindowId === native.start.WindowId && row.ObservationEpoch === native.start.ObservationEpoch && row.WorldGeneration === native.worldGeneration, 'Native record identity mismatch');
          if (u64(row.Sequence) !== nativeSequence || row.GapGeneration !== native.start.GapGeneration) complete = false;
          nativeSequence = u64(row.Sequence) + 1n;
          // Native integrity must not depend on cross-process mapping. Keep these
          // checks aligned with nativeIndex in the analyzer; schema is checked there.
          work.charge();
          if (row.SourceKind !== 0 || row.Flags !== 3) complete = false;
          if (u64(row.PhysicalPublicationOrdinal) < nativePublication) complete = false;
          nativePublication = u64(row.PhysicalPublicationOrdinal);
          if (u64(row.SectionRevisionAfter) <= u64(row.SectionRevisionBefore)) complete = false;
          for (let i = 0; i < 64; i++) {
            work.charge(2);
            if ((u64(row.BlockChanged?.[i]) & ~u64(row.BlockTouched?.[i])) !== 0n ||
                (u64(row.BindingChanged?.[i]) & ~u64(row.BindingTouched?.[i])) !== 0n) complete = false;
          }
        } else check(row.WindowId === window.windowId, 'managed record identity mismatch');
      }
      check(start === bytes.length, 'truncated JSONL'); check(records === Number(count), 'record count integrity mismatch');
      counts.set(file.streamId, (counts.get(file.streamId) ?? 0n) + count);
      const name = `${part.role}-${files.length}.jsonl`;
      files.push({ ...file, path: name }); retained.push({ path: name, bytes });
    }
  }
  for (const [id, expected] of [[window.executionStreamId, u64(window.executionFinal.RecordsWritten)],
    [window.causalStreamId, u64(window.causalFinal.RecordsWritten)],
    [native.id, u64(native.final.Accepted) - u64(native.start.Accepted)]]) {
    check(counts.has(id) || expected === 0n, 'missing declared stream file');
    if (!counts.has(id)) counts.set(id, 0n);
  }
  for (const status of [native.start, native.final]) {
    if (u64(status.Remaining) !== 0n) complete = false;
    if (status.Flags !== 1 || status.FirstAvailableSequence !== status.NextSequence) complete = false;
  }
  for (const field of ['WindowId', 'ObservationEpoch', 'GapGeneration', 'Dropped', 'IncompletePublications', 'UninstrumentedPublications']) {
    if (native.start[field] !== native.final[field]) complete = false;
  }
  if (nativePublication > u64(native.final.PhysicalPublicationOrdinal)) complete = false;
  for (const field of ['NextSequence', 'Accepted', 'Attempted']) if (u64(native.final[field]) - u64(native.start[field]) !== counts.get(native.id)) complete = false;
  let association = null;
  if (metadataPath) {
    const root = await rootPath(metadataPath);
    const bytes = await readBounded(root, Math.min(limits.maxManifestBytes, limits.maxTotalBytes - admittedBytes), work);
    admit(bytes.length); association = json(bytes, work); exact(association, ['windowId', 'mapping', 'evidence']);
    check(association.windowId === window.windowId, 'association window out of range');
    check(Array.isArray(association.evidence), 'missing evidence declarations');
    check(!window.mapping, 'conflicting source and external mapping');
    const evidenceIds = new Set(); const evidenceFiles = [];
    for (const entry of association.evidence) {
      work.charge(); exact(entry, ['id', 'path', 'bytes', 'sha256']);
      check(text(entry.id) && !evidenceIds.has(entry.id), 'duplicate evidence ID'); evidenceIds.add(entry.id);
      const size = u64(entry.bytes); check(size <= BigInt(limits.maxFileBytes) && size <= BigInt(limits.maxTotalBytes - admittedBytes), 'evidence byte limit exceeded');
      admit(Number(size));
      const raw = await readBounded(await containedPath(dirname(root), entry.path), Number(size), work);
      check(raw.length === Number(size) && hash(raw, work) === entry.sha256, 'evidence integrity mismatch');
      const name = `association-evidence-${evidenceFiles.length}.bin`;
      evidenceFiles.push({ ...entry, path: name }); retained.push({ path: name, bytes: raw });
    }
    check(evidenceIds.has(association.mapping?.evidence) && (!association.mapping?.revisions || evidenceIds.has(association.mapping.revisions.evidence)), 'missing mapping evidence reference');
    for (const id of evidenceIds) check(id === association.mapping.evidence || id === association.mapping.revisions?.evidence, 'unreferenced association evidence');
    retained.push({ path: 'association.json', bytes });
    const suppliedMapping = association.mapping;
    association = { path: 'association.json', sha256: hash(bytes, work), evidence: evidenceFiles };
    // Reuse the parsed object; never rewrite raw rows or a source manifest.
    window.mapping = suppliedMapping;
  }
  if (window.mapping) {
    const m = window.mapping;
    exact(m, ['connectionId', 'connectionGeneration', 'clientWorldIncarnation', 'serverWorldIncarnation', 'evidence', 'nativeStreamId', 'nativeWindowId', 'observationEpoch', 'worldGeneration', 'gapGeneration', 'sectionCodec'], ['revisions']);
    for (const field of ['connectionId', 'connectionGeneration', 'clientWorldIncarnation', 'serverWorldIncarnation', 'evidence']) check(text(m[field]), 'missing association identity/evidence');
    for (const field of ['nativeWindowId', 'observationEpoch', 'worldGeneration', 'gapGeneration']) u64(m[field]);
    check(m.nativeStreamId === native.id && m.nativeWindowId === native.start.WindowId && m.observationEpoch === native.start.ObservationEpoch && m.worldGeneration === native.worldGeneration && m.gapGeneration === native.start.GapGeneration && m.sectionCodec === 'VoxelPackedSection.v1', 'association Native identity out of range');
    if (m.revisions) { exact(m.revisions, ['kind', 'clientNamespace', 'serverNamespace', 'evidence']); check(m.revisions.kind === 'identity-section-revisions' && ['clientNamespace', 'serverNamespace', 'evidence'].every(f => text(m.revisions[f])), 'invalid revision mapping'); }
  }
  const manifest = { format: 'lumio-prediction-capture', version: 1, complete, files, windows: [window], nativeStreams: [native],
    identity: { captureId: `assembly:${parts.map(p => p.sha256).join(':')}`, evidence: { parts: parts.map(p => ({ role: p.role, captureId: p.manifest.identity.captureId, path: p.path, sha256: p.sha256 })), association } } };
  let encoded = serialize(manifest, limits.maxManifestBytes, work);
  // Reserve a full manifest ceiling for staging/output, whose inode is shared at publication.
  admit(limits.maxManifestBytes);
  admit(0); // final hard-link directory entry; payload storage is already reserved
  const target = resolve(outputDirectory); const output = join(await rootPath(dirname(target), true), basename(target));
  await mkdir(output); // Exclusive directory creation: never reuse or clean user paths.
  for (const entry of retained) await writeExclusive(join(output, entry.path), entry.bytes, work);
  const staging = join(output, 'manifest.pending');
  await writeExclusive(staging, encoded, work);
  // Analyzer rereads only our private snapshot. Reserve its byte scans/allocations
  // and parser suffix costs before calling; remaining node/reducer work is bounded
  // by its own maxWork. No source pathname is reread after the snapshot copy.
  async function analyzeStaging() {
    let reserve = encoded.length * encoded.length + encoded.length * 8;
    for (const entry of retained) { work.charge(); if (entry.path.endsWith('.jsonl')) reserve += entry.bytes.length * (limits.maxLineBytes + 12); }
    work.charge(reserve);
    const result = await analyzeCapture(staging, { ...limits, maxWork: limits.maxWork - work.used });
    work.charge(result.input.work); return result;
  }
  let analysis = await analyzeStaging();
  const loss = analysis.windows.some(w => w.reasons.some(r => r !== 'missing-or-unsupported-identity-mapping' && r !== 'export-not-complete'));
  if (manifest.complete && loss) {
    manifest.complete = false; encoded = serialize(manifest, limits.maxManifestBytes, work);
    // Our exclusively created staging file is the only file replaced on failure/loss.
    work.charge(encoded.length); const handle = await open(staging, 'r+');
    try { await handle.truncate(0); await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
    analysis = await analyzeStaging();
  }
  work.charge();
  // A same-directory hard link atomically publishes without rename's overwrite
  // behavior. No manifest.json exists on earlier errors; pending files are kept.
  const manifestPath = join(output, 'manifest.json'); await link(staging, manifestPath);
  return { manifestPath, analysis, work: work.used };
}

if (isCliEntry(import.meta.url)) {
  try {
    check(process.argv.length === 6 || process.argv.length === 7, 'usage: node eng/prediction-capture-assemble.mjs <client-manifest> <authority-manifest> <new-output-directory> <limits.json> [association.json]');
    const [, , clientManifest, authorityManifest, outputDirectory, limitsPath, metadataPath] = process.argv;
    const result = await assembleCapture({ clientManifest, authorityManifest, outputDirectory, limits: await loadCaptureLimits(limitsPath), metadataPath });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stdout.write(`${JSON.stringify({ status: 'Rejected', reason: error.message })}\n`); process.exitCode = 1; }
}
