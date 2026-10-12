// Offline only. Raw fields follow PredictionCausalRecord schema 1 (216 bytes),
// PredictionExecutionRecord and native-abi.json ChangeObservationRecordV1.
import { open, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const U64_MAX = (1n << 64n) - 1n;
const CAUSAL_U64 = 'WindowId Sequence ApplicationId RebuildId InputSequence AttemptOrdinal SnapshotId RelatedSnapshotId EvidenceId ParentEvidenceId OtherInputSequence OtherAttemptOrdinal NativeKey SourceJournalKey SectionKey RevisionBefore RevisionAfter ExecutionRecordSequence Value'.split(' ');
const CAUSAL_U32 = 'SchemaVersion Kind Flags CauseBits Outcome AccessKind Role PresenceBefore PresenceAfter NativeReasonBits WitnessCount EdgeCount RootCount Reserved'.split(' ');
const NATIVE_U64 = 'WindowId ObservationEpoch Sequence PhysicalPublicationOrdinal GapGeneration WorldGeneration WorldRevisionBefore WorldRevisionAfter SectionRevisionBefore SectionRevisionAfter'.split(' ');
const MASKS = ['BlockTouched', 'BindingTouched', 'BlockChanged', 'BindingChanged'];
const EXEC_U64 = 'WindowId Sequence InputSequence AttemptOrdinal ElapsedNanos'.split(' ');
const EXEC_STATUS_U64 = 'WindowId RecordsAttempted RecordsWritten RecordsDropped ClockFailures FirstAttempts ReplayAttempts FirstCompleted ReplayCompleted DataWaits BudgetWaits CorrectionRetries Faults Publications TimedFirstAttempts TimedReplayAttempts FirstElapsedNanos ReplayElapsedNanos ExecutionsSincePublication'.split(' ');
const CAUSAL_STATUS_U64 = 'WindowId GapGeneration ApplicationsEntered ApplicationBodiesReturned ApplicationBodiesFaulted ApplicationsWithVerifiedEcsCommit CommittedEcsIngresses ApplicationsWithOutstandingBeforeCoverage ApplicationsWithSurvivorsAfterCoverage RebuildsBegun RebuildsReturned RebuildsWaiting RebuildsFaulted RootsObserved RootsStored RootsOmitted WitnessesCopied WitnessesOmitted EdgesObserved EdgesStored EdgesOmitted SnapshotsComplete SnapshotsIncomplete RecordsAttempted RecordsWritten RecordsDropped DiagnosticWork DiagnosticFaults JoinedFirstAttempts JoinedReplayAttempts JoinedFirstReturned JoinedReplayReturned JoinedTimedFirstAttempts JoinedTimedReplayAttempts JoinedFirstElapsedNanos JoinedReplayElapsedNanos AttemptsWithNativeRevision AttemptsWithNativeUnavailable AttemptsWithEcsState AttemptsWithPropagation AttemptsWithMultipleRoots AttemptsWithIncompleteEvidence'.split(' ');
export const LIMIT_NAMES = ['maxManifestBytes', 'maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxLineBytes', 'maxRecords', 'maxWork'];
function requireThat(condition, message) { if (!condition) throw new Error(message); }
export function u64(value) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'u64 requires a canonical decimal string');
  const result = BigInt(value);
  requireThat(result <= U64_MAX, 'u64 overflow');
  return result;
}
function integer(value, min = 0, max = 0xffffffff) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, 'invalid integer');
  return value;
}
function nonempty(value) { return typeof value === 'string' && value.length > 0; }
function flag(record, bit) { return (record.Flags & bit) !== 0; }
function key(...parts) { return JSON.stringify(parts); }
function unique(map, id, value) { requireThat(!map.has(id), `duplicate identity: ${id}`); map.set(id, value); }
function budget(limits) {
  for (const name of LIMIT_NAMES) integer(limits[name], 1, Number.MAX_SAFE_INTEGER);
  let used = 0;
  return { limits, charge(n = 1) { requireThat(n <= limits.maxWork - used, 'work limit exceeded'); used += n; }, get used() { return used; } };
}

// Bounded JSON parser rejects duplicate object names, invalid UTF-8, excessive
// nesting and unsafe numeric tokens before a Number can erase evidence.
export function parseCaptureJson(bytes, work) {
  // The only unmetered caller is the fixed 4096-byte limits-file bootstrap.
  if (!work) requireThat(bytes.length <= 4096, 'JSON bootstrap byte limit exceeded');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let at = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[at] ?? '\0')) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '\\') { at++; continue; }
      if (c === '"') return JSON.parse(text.slice(start, at));
    }
    throw new Error('unterminated JSON string');
  }
  function value(depth) {
    work?.charge();
    requireThat(depth <= 32, 'JSON nesting limit exceeded'); whitespace();
    const c = text[at];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      const object = c === '{'; const result = object ? Object.create(null) : []; const names = new Set();
      at++; whitespace(); const close = object ? '}' : ']';
      if (text[at] === close) { at++; return result; }
      while (at < text.length) {
        whitespace(); let name;
        if (object) {
          work?.charge();
          requireThat(text[at] === '"', 'expected JSON property'); name = string();
          requireThat(!names.has(name), 'duplicate JSON property'); names.add(name);
          whitespace(); requireThat(text[at++] === ':', 'expected JSON colon');
        }
        const child = value(depth + 1);
        if (object) result[name] = child; else result.push(child);
        whitespace(); const delimiter = text[at++];
        if (delimiter === close) return result;
        requireThat(delimiter === ',', 'invalid JSON delimiter');
      }
      throw new Error('truncated JSON');
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    requireThat(match, 'invalid JSON value'); at += match[0].length;
    const result = JSON.parse(match[0]);
    if (typeof result === 'number') requireThat(Number.isSafeInteger(result), 'JSON numbers must be safe integers');
    return result;
  }
  const result = value(0); whitespace(); requireThat(at === text.length, 'trailing JSON content'); return result;
}

// Exact inverse of Runtime Coordination/Voxel/VoxelPackedSection.cs Encode:
// ((uint)x & 0x0FFF_FFFF) << 36 | y << 32 | (uint)z. Native ABI
// SectionX/i32, SectionY/u32, SectionZ/i32 are compared as coordinates.
export function decodePackedSection(value) {
  const packed = u64(value);
  return [Number(BigInt.asIntN(28, packed >> 36n)), Number((packed >> 32n) & 15n), Number(BigInt.asIntN(32, packed))];
}
function section(record) { return key(record.SectionX, record.SectionY, record.SectionZ); }
function witnessSection(record) { return key(...decodePackedSection(record.SectionKey)); }
function validateRecord(record, kind, work) {
  requireThat(record && typeof record === 'object' && !Array.isArray(record), 'record must be an object');
  const fields = kind === 'causal' ? CAUSAL_U64 : kind === 'native' ? NATIVE_U64 : EXEC_U64;
  const allowed = new Set([...fields, ...(kind === 'causal' ? [...CAUSAL_U32, 'NativeStatus', 'CellOffset'] : kind === 'native' ? [...MASKS, 'StructSize', 'Version', 'Reserved', 'Flags', 'SourceKind', 'SectionX', 'SectionY', 'SectionZ'] : ['Kind', 'Outcome', 'Replay', 'HasElapsed'])]);
  for (const field of Object.keys(record)) requireThat(allowed.has(field), `unsupported ${kind} record field: ${field}`);
  for (const field of fields) { work.charge(); u64(record[field]); }
  if (kind === 'causal') {
    for (const field of CAUSAL_U32) integer(record[field]);
    integer(record.NativeStatus, -2147483648, 2147483647); integer(record.CellOffset, -2147483648, 2147483647);
    requireThat(record.SchemaVersion === 1 && record.Kind >= 1 && record.Kind <= 16 && record.Reserved === 0, 'unsupported causal schema/kind');
    requireThat(record.Flags <= 8191 && record.CauseBits <= 255, 'unsupported causal flags/causes');
  } else if (kind === 'execution') {
    integer(record.Kind, 0, 2); integer(record.Outcome, 0, 5);
    requireThat(typeof record.Replay === 'boolean' && typeof record.HasElapsed === 'boolean', 'invalid execution flags');
  } else {
    requireThat(record.StructSize === 2160 && record.Version === 1 && record.Reserved === 0, 'unsupported Native layout');
    integer(record.SectionX, -(2 ** 27), 2 ** 27 - 1); integer(record.SectionY, 0, 15); integer(record.SectionZ, -2147483648, 2147483647);
    integer(record.SourceKind, 0, 1); integer(record.Flags, 0, 15);
    for (const field of MASKS) {
      requireThat(Array.isArray(record[field]) && record[field].length === 64, 'Native mask must contain 64 u64 words');
      for (const word of record[field]) { work.charge(); u64(word); }
    }
  }
}

async function boundedFile(path, maxBytes) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat(); requireThat(stat.isFile() && stat.size <= maxBytes, 'file limit exceeded or not a regular file');
    // Reading through a bounded buffer also handles concurrent growth.
    const buffer = Buffer.alloc(stat.size + 1); let size = 0;
    while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    requireThat(size === stat.size, 'file changed while reading');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

export async function loadCaptureLimits(path) { return parseCaptureJson(await boundedFile(path, 4096)); }

export async function analyzeCapture(manifestPath, limits) {
  const work = budget(limits);
  const bytes = await boundedFile(manifestPath, Math.min(limits.maxManifestBytes, limits.maxTotalBytes));
  const manifest = parseCaptureJson(bytes, work);
  requireThat(manifest.format === 'lumio-prediction-capture' && manifest.version === 1, 'unsupported capture manifest');
  requireThat(Array.isArray(manifest.files) && manifest.files.length <= limits.maxFiles, 'file count limit exceeded');
  requireThat(Array.isArray(manifest.windows) && Array.isArray(manifest.nativeStreams), 'missing capture identities');
  const base = await realpath(dirname(resolve(manifestPath)));
  const paths = new Set(); const records = []; let totalBytes = bytes.length;
  for (const file of manifest.files) {
    work.charge(); requireThat(['execution', 'causal', 'native'].includes(file.kind) && nonempty(file.streamId), 'unsupported stream');
    requireThat(nonempty(file.path) && !isAbsolute(file.path), 'file path must be relative');
    const path = await realpath(resolve(base, file.path)); const rel = relative(base, path);
    requireThat(rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel), 'capture file escapes manifest directory');
    requireThat(!paths.has(path), 'duplicate capture file'); paths.add(path);
    const expectedBytes = u64(file.bytes); const expectedRecords = u64(file.records);
    requireThat(expectedBytes <= BigInt(limits.maxFileBytes) && expectedBytes <= BigInt(limits.maxTotalBytes - totalBytes), 'file/total byte limit exceeded');
    requireThat(expectedRecords <= BigInt(limits.maxRecords - records.length), 'record limit exceeded');
    requireThat(typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256), 'invalid SHA256');
    const raw = await boundedFile(path, Number(expectedBytes)); totalBytes += raw.length;
    requireThat(BigInt(raw.length) === expectedBytes && createHash('sha256').update(raw).digest('hex') === file.sha256, 'file integrity mismatch');
    let start = 0; let count = 0;
    for (let end = 0; end < raw.length; end++) {
      requireThat(end - start < limits.maxLineBytes, 'line limit exceeded');
      if (raw[end] !== 10) continue;
      requireThat(records.length < limits.maxRecords, 'record limit exceeded');
      requireThat(end > start, 'empty JSON record');
      const record = parseCaptureJson(raw.subarray(start, end), work); work.charge(); validateRecord(record, file.kind, work);
      records.push({ kind: file.kind, streamId: file.streamId, record }); count++; start = end + 1;
    }
    requireThat(start === raw.length, 'truncated JSONL: final LF required');
    requireThat(BigInt(count) === expectedRecords, 'record count integrity mismatch');
  }
  requireThat(totalBytes <= limits.maxTotalBytes, 'total byte limit exceeded');
  const report = reduceCapture(manifest, records, work);
  return { ...report, input: { files: paths.size, records: records.length, bytes: totalBytes, work: work.used, manifestSha256: createHash('sha256').update(bytes).digest('hex') } };
}

function reasonSet() { const values = new Set(); return { add(reason) { values.add(reason); }, get values() { return [...values].sort(); }, get any() { return values.size > 0; } }; }
function managedIntegrity(start, final, rows, windowId, reasons, work, causal = false) {
  if (!start || !final) { reasons.add('missing-start-or-final-status'); return false; }
  for (const status of [start, final]) {
    for (const f of causal ? CAUSAL_STATUS_U64 : EXEC_STATUS_U64) { work.charge(); u64(status[f]); }
    if (status.WindowId !== windowId || status.Saturated !== false) reasons.add('managed-status-identity-or-saturation');
  }
  if (start.Enabled !== true || start.StopReason !== 0 || final.Enabled !== false || !Number.isInteger(final.StopReason) || final.StopReason < 1 || final.StopReason > (causal ? 7 : 6) || final.BufferedRecords !== 0) reasons.add('managed-status-not-final');
  // Version 1 supports full managed windows only, starting before first append.
  if (start.RecordsAttempted !== '0' || start.RecordsWritten !== '0' || start.RecordsDropped !== '0' || start.BufferedRecords !== 0) reasons.add('partial-managed-window');
  for (const field of causal ? CAUSAL_STATUS_U64 : EXEC_STATUS_U64) {
    work.charge(); if (field !== 'WindowId' && start[field] !== '0') reasons.add('nonempty-managed-start-status');
  }
  if (final.RecordsDropped !== '0' || u64(final.RecordsWritten) !== BigInt(rows.length) || u64(final.RecordsAttempted) !== BigInt(rows.length)) reasons.add('managed-record-loss');
  let previous = 0n;
  for (const row of rows) { work.charge(); if (u64(row.Sequence) !== previous + 1n) reasons.add('managed-sequence-gap'); previous = u64(row.Sequence); }
  if (causal) {
    for (const field of ['GapGeneration', 'RootsOmitted', 'WitnessesOmitted', 'EdgesOmitted', 'SnapshotsIncomplete', 'DiagnosticFaults']) {
      if (final[field] === undefined || u64(final[field]) !== 0n) reasons.add('causal-incomplete-status');
    }
    if (final.ClosureIncomplete !== false || final.ActiveSnapshotAtStop !== false) reasons.add('causal-closure-incomplete');
  }
  const summaryReasons = reasonSet();
  if (final.WindowId !== windowId || final.Saturated !== false || final.Enabled !== false || !Number.isInteger(final.StopReason) || final.StopReason < 1 || final.StopReason > (causal ? 7 : 6) || final.BufferedRecords !== 0) summaryReasons.add('invalid-final-summary');
  if (!causal) {
    for (const name of ['First', 'Replay']) {
      if (u64(final[`Timed${name}Attempts`]) > u64(final[`${name}Attempts`]) || u64(final[`${name}Completed`]) > u64(final[`${name}Attempts`]) || (final[`Timed${name}Attempts`] === '0' && final[`${name}ElapsedNanos`] !== '0')) summaryReasons.add('invalid-final-summary');
    }
  } else if (u64(final.ApplicationsWithOutstandingBeforeCoverage) > u64(final.ApplicationsEntered)) summaryReasons.add('invalid-final-summary');
  // Missing detail is allowed beneath trustworthy final counters. Surviving
  // detail can never exceed them; equality is required only for a full export.
  const fullDetail = !reasons.any;
  {
    const counts = new Map(); const add = (field, n = 1n) => counts.set(field, (counts.get(field) ?? 0n) + n);
    for (const r of rows) {
      work.charge();
      if (!causal && r.Kind === 0) {
        const name = r.Replay ? 'Replay' : 'First'; add(`${name}Attempts`);
        if (r.Outcome === 1) add(`${name}Completed`);
        if (r.HasElapsed) { add(`Timed${name}Attempts`); add(`${name}ElapsedNanos`, u64(r.ElapsedNanos)); }
        const outcome = { 2: 'DataWaits', 3: 'BudgetWaits', 4: 'CorrectionRetries', 5: 'Faults' }[r.Outcome]; if (outcome) add(outcome);
      } else if (!causal && r.Kind === 1) add('Publications');
      else if (causal) {
        if (r.Kind === 1) add('ApplicationsEntered');
        if (r.Kind === 1 && r.WitnessCount > 0) add('ApplicationsWithOutstandingBeforeCoverage');
        if (r.Kind === 2) add(r.Outcome === 1 ? 'ApplicationBodiesReturned' : 'ApplicationBodiesFaulted');
        if (r.Kind === 3) add('RebuildsBegun');
        if (r.Kind === 4) add({ 1: 'RebuildsReturned', 2: 'RebuildsWaiting', 3: 'RebuildsFaulted' }[r.Outcome] ?? 'UnsupportedRebuild');
        if (r.Kind === 9) { add('RootsStored'); add('RootsObserved'); }
        if (r.Kind === 10) { add('EdgesStored'); add('EdgesObserved'); }
        if ([5, 6, 7, 8, 11].includes(r.Kind)) add('WitnessesCopied');
        if (r.Kind === 12) add(flag(r, 1) ? 'SnapshotsComplete' : 'SnapshotsIncomplete');
        if (r.Kind === 13) {
          const name = flag(r, 8) ? 'Replay' : 'First'; add(`Joined${name}Attempts`);
          if (r.Outcome === 1) add(`Joined${name}Returned`);
          if (flag(r, 128)) { add(`JoinedTimed${name}Attempts`); add(`Joined${name}ElapsedNanos`, u64(r.Value)); }
        }
      }
    }
    const fields = causal
      ? 'ApplicationsEntered ApplicationsWithOutstandingBeforeCoverage ApplicationBodiesReturned ApplicationBodiesFaulted RebuildsBegun RebuildsReturned RebuildsWaiting RebuildsFaulted RootsStored RootsObserved EdgesStored WitnessesCopied SnapshotsComplete SnapshotsIncomplete JoinedFirstAttempts JoinedReplayAttempts JoinedFirstReturned JoinedReplayReturned JoinedTimedFirstAttempts JoinedTimedReplayAttempts JoinedFirstElapsedNanos JoinedReplayElapsedNanos'
      : 'FirstAttempts ReplayAttempts FirstCompleted ReplayCompleted TimedFirstAttempts TimedReplayAttempts FirstElapsedNanos ReplayElapsedNanos DataWaits BudgetWaits CorrectionRetries Faults Publications';
    for (const field of fields.split(' ')) {
      work.charge(); const observed = counts.get(field) ?? 0n; const reported = u64(final[field]);
      if (reported < observed || (fullDetail && reported !== observed)) summaryReasons.add('status-detail-counter-mismatch');
    }
  }
  for (const reason of summaryReasons.values) reasons.add(reason);
  return !summaryReasons.any;
}

function nativeIndex(stream, rows, work) {
  const reasons = reasonSet(); const transitions = new Map(); const start = stream.start; const final = stream.final;
  if (!start || !final) reasons.add('missing-native-start-or-final-stats');
  else {
    for (const s of [start, final]) {
      requireThat(s.StructSize === 128 && s.Version === 1 && s.Reserved === 0, 'unsupported Native stats layout');
      for (const f of ['WindowId', 'ObservationEpoch', 'GapGeneration', 'PhysicalPublicationOrdinal', 'Attempted', 'Accepted', 'Dropped', 'IncompletePublications', 'UninstrumentedPublications', 'FirstAvailableSequence', 'NextSequence', 'ReservedBytes', 'Written', 'Remaining']) u64(s[f]);
      if (s.Flags !== 1) reasons.add('native-disabled-or-saturated');
      if (s.Remaining !== '0') reasons.add('native-undrained-stats');
      if (s.FirstAvailableSequence !== s.NextSequence) reasons.add('native-nonempty-sequence-cut');
    }
    for (const field of ['WindowId', 'ObservationEpoch', 'GapGeneration', 'Dropped', 'IncompletePublications', 'UninstrumentedPublications']) {
      if (start[field] !== final[field]) reasons.add('native-boundary-or-loss');
    }
    if (u64(final.NextSequence) - u64(start.NextSequence) !== BigInt(rows.length) || u64(final.Accepted) - u64(start.Accepted) !== BigInt(rows.length)) reasons.add('native-export-loss');
  }
  let previous = start ? u64(start.NextSequence) - 1n : -1n;
  let publication = start ? u64(start.PhysicalPublicationOrdinal) : 0n;
  for (const r of rows) {
    work.charge();
    if (u64(r.Sequence) !== previous + 1n) reasons.add('native-sequence-gap'); previous = u64(r.Sequence);
    if (start && (r.WindowId !== start.WindowId || r.ObservationEpoch !== start.ObservationEpoch || r.GapGeneration !== start.GapGeneration)) reasons.add('native-epoch-or-gap-change');
    if (r.WorldGeneration !== stream.worldGeneration) reasons.add('native-world-generation-change');
    if (r.SourceKind !== 0 || r.Flags !== 3) reasons.add('native-incomplete-or-boundary');
    if (u64(r.PhysicalPublicationOrdinal) < publication) reasons.add('native-publication-order');
    publication = u64(r.PhysicalPublicationOrdinal);
    if (u64(r.SectionRevisionAfter) <= u64(r.SectionRevisionBefore)) reasons.add('native-invalid-revision-transition');
    const id = key(section(r), r.SectionRevisionBefore);
    unique(transitions, id, r);
    for (let i = 0; i < 64; i++) {
      work.charge(2);
      if ((u64(r.BlockChanged[i]) & ~u64(r.BlockTouched[i])) !== 0n || (u64(r.BindingChanged[i]) & ~u64(r.BindingTouched[i])) !== 0n) reasons.add('changed-mask-outside-touched');
    }
  }
  if (final && publication > u64(final.PhysicalPublicationOrdinal)) reasons.add('native-final-publication-mismatch');
  return { stream, transitions, reasons };
}

function mappingValid(window, native) {
  const m = window.mapping;
  if (!m || !native || !native.stream.start) return false;
  for (const f of ['connectionId', 'connectionGeneration', 'clientWorldIncarnation', 'serverWorldIncarnation', 'evidence']) if (!nonempty(m[f])) return false;
  const rev = m.revisions;
  if (!rev || rev.kind !== 'identity-section-revisions' || !nonempty(rev.clientNamespace) || !nonempty(rev.serverNamespace) || !nonempty(rev.evidence)) return false;
  if (m.sectionCodec !== 'VoxelPackedSection.v1') return false;
  return m.nativeWindowId === native.stream.start.WindowId && m.observationEpoch === native.stream.start.ObservationEpoch && m.worldGeneration === native.stream.worldGeneration && m.gapGeneration === native.stream.start.GapGeneration;
}

function snapshotIndex(rows, work) {
  const snapshots = new Map(); const roots = new Map(); const owners = new Map(); const links = new Map(); const linksBySnapshot = new Map(); const applications = new Map(); const rebuilds = new Map();
  const latestSnapshot = new Map();
  function snapshot(id) {
    if (!snapshots.has(id)) snapshots.set(id, { witnesses: [], samples: [], edges: [], memberships: new Map() });
    return snapshots.get(id);
  }
  for (const r of rows) {
    work.charge();
    if ([5, 6, 7, 10, 11, 12].includes(r.Kind)) {
      const s = snapshot(r.SnapshotId);
      if (r.Kind === 5 || r.Kind === 12) {
        const name = r.Kind === 5 ? 'begin' : 'end'; requireThat(!s[name], 'duplicate snapshot boundary'); s[name] = r;
        if (r.Kind === 5) {
          s.predecessorMismatch = r.RelatedSnapshotId !== (latestSnapshot.get(r.InputSequence) ?? '0');
          latestSnapshot.set(r.InputSequence, r.SnapshotId);
        }
      } else if (r.Kind === 6) s.witnesses.push(r);
      else if (r.Kind === 7) s.samples.push(r);
      else if (r.Kind === 10) s.edges.push(r);
      else unique(s.memberships, r.EvidenceId, r);
    }
    if (r.Kind === 9) unique(roots, r.EvidenceId, r);
    if (r.Kind === 8) unique(owners, r.NativeKey, r);
    if (r.Kind === 13) { unique(links, key(r.InputSequence, r.AttemptOrdinal), r); unique(linksBySnapshot, r.SnapshotId, r); }
    if (r.Kind === 1 || r.Kind === 2 || r.Kind === 3 || r.Kind === 4) {
      const map = r.Kind <= 2 ? applications : rebuilds; const id = r.Kind <= 2 ? r.ApplicationId : r.RebuildId;
      if (!map.has(id)) map.set(id, {});
      const item = map.get(id); const side = r.Kind % 2 ? 'begin' : 'end'; requireThat(!item[side], 'duplicate application/rebuild identity'); item[side] = r;
    }
  }
  // A snapshot/sample cannot be reused through an observed authority or rebuild
  // cut. The producer opens a new snapshot around Correct/refresh operations;
  // captures that violate this minimum cut discipline remain unsupported.
  const cuts = rows.filter(r => r.Kind === 1 || r.Kind === 3);
  for (const s of snapshots.values()) {
    if (!s.begin || !s.end) continue;
    for (const cut of cuts) {
      work.charge(); if (u64(cut.Sequence) > u64(s.begin.Sequence) && u64(cut.Sequence) < u64(s.end.Sequence)) s.crossesCut = true;
    }
  }
  return { snapshots, roots, owners, links, linksBySnapshot, applications, rebuilds };
}

function completeSnapshot(s, reasons, work) {
  work.charge();
  if (!s?.begin || !s?.end) { reasons.add('missing-snapshot-boundary'); return false; }
  const b = s.begin; const e = s.end;
  if (s.predecessorMismatch) reasons.add('snapshot-predecessor-mismatch');
  if (s.crossesCut) reasons.add('snapshot-crosses-authority-cut');
  if (!flag(e, 1) || flag(e, 2 | 32 | 64) || b.InputSequence !== e.InputSequence || b.AttemptOrdinal !== e.AttemptOrdinal || u64(b.Sequence) >= u64(e.Sequence)) reasons.add('incomplete-snapshot');
  if (e.WitnessCount !== s.witnesses.length || e.EdgeCount !== s.edges.length || e.RootCount !== s.memberships.size) reasons.add('snapshot-count-mismatch');
  for (const r of [...s.witnesses, ...s.samples, ...s.edges, ...s.memberships.values()]) {
    work.charge(); if (u64(r.Sequence) <= u64(b.Sequence) || u64(r.Sequence) >= u64(e.Sequence)) reasons.add('record-outside-snapshot');
    if (flag(r, 2 | 32 | 64)) reasons.add('incomplete-snapshot-record');
  }
  return true;
}

function classifyRoot(root, index, native, reasons, work) {
  let collateral = false; let other = false; const details = new Set(); const events = new Set();
  if (!root) { reasons.add('missing-root'); return { collateral, other, details: [], events: [] }; }
  if (flag(root, 2 | 32 | 64)) reasons.add('incomplete-root');
  if (root.ParentEvidenceId !== '0' || root.CauseBits === 0 || (root.CauseBits & (8 | 16 | 32 | 64 | 128)) !== 0) reasons.add('unsupported-or-unobserved-root');
  if ((root.NativeReasonBits & ~7) !== 0 || ((root.NativeReasonBits & 2) !== 0 && !(root.CauseBits & 1)) || ((root.NativeReasonBits & 4) !== 0 && !(root.CauseBits & 2))) reasons.add('native-reason-cause-mismatch');
  if (root.CauseBits & 2) { other = true; details.add('NativeUnavailable'); }
  if (root.CauseBits & 4) { other = true; details.add('EcsState'); }
  const app = index.applications.get(root.ApplicationId); const rebuild = index.rebuilds.get(root.RebuildId);
  if (!app?.begin || !app?.end || app.end.Outcome !== 1 || u64(app.begin.Sequence) >= u64(app.end.Sequence)) reasons.add('unobserved-or-faulted-application');
  if (!rebuild?.begin || !rebuild?.end || rebuild.begin.ApplicationId !== root.ApplicationId || rebuild.end.ApplicationId !== root.ApplicationId) reasons.add('unobserved-or-ambiguous-rebuild');
  const snapshot = index.snapshots.get(root.SnapshotId);
  if (!completeSnapshot(snapshot, reasons, work)) return { collateral, other, details: [...details], events: [] };
  if (app?.end && rebuild?.begin && rebuild?.end &&
      !(u64(app.end.Sequence) < u64(rebuild.begin.Sequence) &&
        u64(rebuild.begin.Sequence) < u64(snapshot.begin.Sequence) &&
        u64(snapshot.end.Sequence) < u64(rebuild.end.Sequence))) reasons.add('application-rebuild-snapshot-order');
  if (snapshot.begin.InputSequence !== root.InputSequence || snapshot.begin.AttemptOrdinal !== root.AttemptOrdinal) reasons.add('root-snapshot-identity-mismatch');
  if (!snapshot.memberships.has(root.EvidenceId) || u64(root.Sequence) <= u64(snapshot.begin.Sequence) || u64(root.Sequence) >= u64(snapshot.end.Sequence)) reasons.add('root-outside-original-snapshot');
  if (!(root.CauseBits & 1)) return { collateral, other, details: [...details], events: [] };
  if (!native || native.reasons.any) reasons.add('native-history-incomplete');
  let relevant = 0; let unrelated = 0; let nativeOther = false;
  // Inspect all retained dependencies, including witnesses gameplay short-circuited.
  for (const witness of snapshot.witnesses) {
    work.charge();
    if (![1, 2].includes(witness.Role) || ![1, 2].includes(witness.AccessKind) || witness.CellOffset < 0 || witness.CellOffset >= 4096) { reasons.add('unsupported-witness'); continue; }
    if (witness.InputSequence !== snapshot.begin.InputSequence || witness.AttemptOrdinal !== snapshot.begin.AttemptOrdinal) reasons.add('witness-identity-mismatch');
    if (!flag(witness, 512)) reasons.add('missing-source-owner-evidence');
    if (witness.SourceJournalKey !== '0') {
      const owner = index.owners.get(witness.SourceJournalKey);
      const owned = owner && index.snapshots.get(owner.SnapshotId);
      if (!owner || !flag(owner, 256) || u64(owner.Sequence) >= u64(witness.Sequence) || !owned?.begin || owner.InputSequence !== owned.begin.InputSequence || owner.AttemptOrdinal !== owned.begin.AttemptOrdinal) reasons.add('missing-source-owner');
      else completeSnapshot(owned, reasons, work);
    }
    if (witness.Role === 2) {
      const owner = index.owners.get(witness.NativeKey);
      if (!flag(witness, 256) || !owner || owner.InputSequence !== witness.InputSequence || owner.AttemptOrdinal !== witness.AttemptOrdinal || u64(owner.Sequence) >= u64(witness.Sequence)) reasons.add('missing-write-owner');
    }
    const samples = [];
    for (const sample of snapshot.samples) {
      work.charge();
      if (sample.SectionKey === witness.SectionKey && sample.AccessKind === witness.AccessKind) samples.push(sample);
    }
    if (samples.length !== 1) { reasons.add('missing-or-ambiguous-current-sample'); continue; }
    const sample = samples[0];
    // Runtime Sample emits a Section/lane observation, owned by SnapshotId.
    // It never emits per-input, per-attempt, cell or old-revision identity.
    if (sample.InputSequence !== '0' || sample.AttemptOrdinal !== '0' || sample.CellOffset !== 0 || sample.RevisionBefore !== '0') { reasons.add('sample-identity-mismatch'); continue; }
    if (!flag(sample, 16) || flag(sample, 2 | 64) || sample.NativeStatus !== 0) { reasons.add('invalid-current-sample'); continue; }
    // Presence 0 is Ready in the typed Voxel API; non-ready or a transition
    // cannot provide a negative cell-history claim.
    if (sample.PresenceAfter !== 0 || (witness.Role === 1 && witness.PresenceBefore !== 0)) { other = true; nativeOther = true; details.add('Availability'); continue; }
    let revision = u64(witness.RevisionBefore); const end = u64(sample.RevisionAfter);
    if (end < revision) { reasons.add('revision-regression'); continue; }
    const isRelevant = witness.SectionKey === root.SectionKey;
    if (isRelevant) relevant++;
    let touched = false; let changed = false; let elsewhere = false; let transitions = 0;
    const lane = witness.AccessKind === 1 ? 'Block' : 'Binding'; const word = Math.floor(witness.CellOffset / 64); const bit = 1n << BigInt(witness.CellOffset % 64);
    while (revision < end) {
      work.charge();
      const transition = native?.transitions.get(key(witnessSection(witness), revision.toString()));
      if (!transition || u64(transition.SectionRevisionAfter) > end) { reasons.add('missing-section-transition'); break; }
      touched ||= (u64(transition[`${lane}Touched`][word]) & bit) !== 0n;
      changed ||= (u64(transition[`${lane}Changed`][word]) & bit) !== 0n;
      for (let i = 0; i < 64; i++) { work.charge(2); if (u64(transition.BlockChanged[i]) !== 0n || u64(transition.BindingChanged[i]) !== 0n) elsewhere = true; }
      if (isRelevant) events.add(transition.PhysicalPublicationOrdinal);
      revision = u64(transition.SectionRevisionAfter); transitions++;
    }
    if (changed) { other = true; nativeOther = true; details.add('Direct'); }
    else if (touched) { other = true; nativeOther = true; details.add('RevisionOnly'); }
    else if (isRelevant && transitions > 0 && elsewhere && revision === end) unrelated++;
    else if (isRelevant) reasons.add('no-proven-unrelated-mutation');
  }
  if (relevant === 0) reasons.add('root-without-mapped-witness');
  if (unrelated === relevant && relevant > 0 && !nativeOther) { collateral = true; details.add('UnrelatedSectionMutation'); }
  return { collateral, other, details: [...details], events: [...events] };
}

function validateMembership(initial, index, reasons, work) {
  const pending = [initial]; const seen = new Set();
  while (pending.length) {
  work.charge(); const s = pending.pop();
  if (!s || seen.has(s)) { if (!s) reasons.add('missing-snapshot'); continue; }
  seen.add(s);
  if (!completeSnapshot(s, reasons, work)) continue;
  if (s.begin.RelatedSnapshotId !== '0') {
    const prior = index.snapshots.get(s.begin.RelatedSnapshotId);
    if (completeSnapshot(prior, reasons, work)) {
      pending.push(prior);
      if (prior.begin.InputSequence !== s.begin.InputSequence || u64(prior.begin.AttemptOrdinal) > u64(s.begin.AttemptOrdinal) || u64(prior.end.Sequence) >= u64(s.begin.Sequence)) reasons.add('predecessor-identity-or-order');
      // EndAttempt can clear the live union after a returned execution. In the
      // absence of that observed boundary, every incoming root must survive.
      const returned = index.linksBySnapshot.get(prior.begin.SnapshotId);
      const mayReset = returned?.Outcome === 1 && u64(returned.Sequence) > u64(prior.end.Sequence) && u64(returned.Sequence) < u64(s.begin.Sequence);
      if (!mayReset) for (const id of prior.memberships.keys()) { work.charge(); if (!s.memberships.has(id)) reasons.add('lost-predecessor-root'); }
    }
  }
  for (const edge of s.edges) {
    work.charge(); const source = index.snapshots.get(edge.RelatedSnapshotId);
    if (!completeSnapshot(source, reasons, work)) continue;
    pending.push(source);
    if (![1, 2, 3, 4, 5].includes(edge.Role) || edge.InputSequence !== s.begin.InputSequence || edge.AttemptOrdinal !== s.begin.AttemptOrdinal || edge.OtherInputSequence !== source.begin.InputSequence || edge.OtherAttemptOrdinal !== source.begin.AttemptOrdinal || u64(edge.OtherInputSequence) >= u64(edge.InputSequence)) reasons.add('edge-identity-or-order');
    for (const id of source.memberships.keys()) { work.charge(); if (!s.memberships.has(id)) reasons.add('missing-propagated-root'); }
  }
  for (const id of s.memberships.keys()) {
    work.charge(); const root = index.roots.get(id);
    if (!root) { reasons.add('missing-root'); continue; }
    if (u64(root.Sequence) >= u64(s.memberships.get(id).Sequence)) reasons.add('membership-precedes-root');
    if (root.InputSequence === s.begin.InputSequence) continue;
    let supported = false;
    for (const edge of s.edges) {
      work.charge(); if (index.snapshots.get(edge.RelatedSnapshotId)?.memberships.has(id)) supported = true;
    }
    if (!supported) reasons.add('unobserved-propagation-edge');
  }
  }
}

function aggregate(attempts) {
  const result = {};
  for (const category of ['first', 'replay']) {
    const selected = attempts.filter(a => a.replay === (category === 'replay'));
    const buckets = {};
    for (const name of ['PureCollateral', 'Mixed', 'KnownNonCollateral', 'Unknown']) {
      const rows = selected.filter(a => a.bucket === name);
      const timed = rows.filter(a => a.elapsedNanos !== null);
      buckets[name] = { attempts: rows.length, returned: rows.filter(a => a.outcome === 1).length, timed: timed.length, untimed: rows.length - timed.length, observedElapsedNanos: timed.reduce((sum, a) => sum + u64(a.elapsedNanos), 0n).toString() };
    }
    const outcomes = {};
    for (const row of selected) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
    result[category] = { attempts: selected.length, outcomes, buckets };
  }
  return result;
}

export function reduceCapture(manifest, rows, work) {
  const native = new Map(); const windows = new Map(); const streamKinds = new Map(); const grouped = new Map();
  for (const row of rows) {
    work.charge(); const id = key(row.kind, row.streamId); if (!grouped.has(id)) grouped.set(id, []); grouped.get(id).push(row.record);
  }
  for (const stream of manifest.nativeStreams) {
    work.charge(); requireThat(nonempty(stream.id), 'missing native stream ID'); u64(stream.worldGeneration);
    unique(native, stream.id, nativeIndex(stream, grouped.get(key('native', stream.id)) ?? [], work)); streamKinds.set(key('native', stream.id), true);
  }
  const attempts = []; const windowReports = []; const allAttemptIds = new Set(); const exposedApplications = new Set();
  for (const window of manifest.windows) {
    work.charge(); u64(window.windowId); unique(windows, window.windowId, window);
    requireThat(nonempty(window.executionStreamId) && nonempty(window.causalStreamId), 'missing managed stream ID');
    for (const [kind, id] of [['execution', window.executionStreamId], ['causal', window.causalStreamId]]) unique(streamKinds, key(kind, id), true);
    const executions = grouped.get(key('execution', window.executionStreamId)) ?? [];
    const causal = grouped.get(key('causal', window.causalStreamId)) ?? [];
    const reasons = reasonSet();
    if (manifest.complete !== true) reasons.add('export-not-complete');
    const source = native.get(window.mapping?.nativeStreamId);
    if (!mappingValid(window, source)) reasons.add('missing-or-unsupported-identity-mapping');
    if (source?.reasons.any) for (const reason of source.reasons.values) reasons.add(reason);
    const executionReasons = reasonSet(); const causalReasons = reasonSet();
    const executionSummaryTrusted = managedIntegrity(window.executionStart, window.executionFinal, executions, window.windowId, executionReasons, work);
    const causalSummaryTrusted = managedIntegrity(window.causalStart, window.causalFinal, causal, window.windowId, causalReasons, work, true);
    for (const reason of [...executionReasons.values, ...causalReasons.values]) reasons.add(reason);
    const sequenceIds = new Set();
    for (const [kind, list] of [['execution', executions], ['causal', causal]]) for (const r of list) {
      work.charge(); const id = key(kind, r.Sequence); requireThat(!sequenceIds.has(id), 'duplicate record sequence'); sequenceIds.add(id);
      if (r.WindowId !== window.windowId) reasons.add('record-window-mismatch');
      if (kind === 'causal' && (r.Kind === 15 || flag(r, 64))) reasons.add('causal-gap-or-saturation');
    }
    const index = snapshotIndex(causal, work);
    for (const [applicationId, app] of index.applications) {
      work.charge(); if (app.begin?.WitnessCount > 0 && app.end && applicationId !== '0') exposedApplications.add(key(window.windowId, applicationId));
    }
    const entered = executions.filter(r => r.Kind === 0);
    const firstCount = entered.filter(r => !r.Replay).length; const replayCount = entered.length - firstCount;
    if (window.executionFinal && (window.executionFinal.FirstAttempts !== String(firstCount) || window.executionFinal.ReplayAttempts !== String(replayCount))) reasons.add('execution-summary-detail-mismatch');
    const consumedLinks = new Set();
    for (const execution of entered) {
      work.charge(); const attemptId = key(window.windowId, execution.InputSequence, execution.AttemptOrdinal);
      requireThat(!allAttemptIds.has(attemptId), 'duplicate attempt identity'); allAttemptIds.add(attemptId);
      const local = reasonSet(); for (const reason of reasons.values) local.add(reason);
      const link = index.links.get(key(execution.InputSequence, execution.AttemptOrdinal));
      const rootResults = []; let causes = 0; const applications = new Set(); const events = new Set();
      if (!link) local.add('missing-attempt-link');
      else {
        consumedLinks.add(link);
        causes = link.CauseBits;
        if (!flag(link, 1) || flag(link, 2 | 32 | 64) || link.ExecutionRecordSequence !== execution.Sequence || link.Outcome !== execution.Outcome || flag(link, 8) !== execution.Replay || flag(link, 128) !== execution.HasElapsed || (execution.HasElapsed && link.Value !== execution.ElapsedNanos)) local.add('attempt-link-mismatch-or-incomplete');
        const snapshot = index.snapshots.get(link.SnapshotId);
        validateMembership(snapshot, index, local, work);
        if (snapshot?.begin && (snapshot.begin.InputSequence !== execution.InputSequence || snapshot.begin.AttemptOrdinal !== execution.AttemptOrdinal)) local.add('attempt-snapshot-identity-mismatch');
        if (snapshot?.begin && snapshot.begin.RelatedSnapshotId !== link.RelatedSnapshotId) local.add('attempt-incoming-snapshot-mismatch');
        if (snapshot?.end && u64(snapshot.end.Sequence) >= u64(link.Sequence)) local.add('attempt-link-before-snapshot-end');
        if (!snapshot || link.RootCount !== snapshot.memberships.size) local.add('attempt-root-count-mismatch');
        if (link.RelatedSnapshotId !== '0') {
          const incoming = index.snapshots.get(link.RelatedSnapshotId);
          validateMembership(incoming, index, local, work);
          for (const id of incoming?.memberships.keys() ?? []) { work.charge(); if (!snapshot?.memberships.has(id)) local.add('lost-incoming-root'); }
        }
        let rootCauses = 0;
        for (const rootId of snapshot?.memberships.keys() ?? []) {
          work.charge(); const root = index.roots.get(rootId);
          if (root) { rootCauses |= root.CauseBits; causes |= root.CauseBits; applications.add(root.ApplicationId); }
          const result = classifyRoot(root, index, source, local, work); rootResults.push({ rootId, ...result });
          for (const event of result.events) events.add(event);
        }
        if (rootCauses !== link.CauseBits) local.add('attempt-cause-union-mismatch');
      }
      if (rootResults.length === 0) local.add('no-proven-root');
      const collateral = rootResults.some(r => r.collateral); const other = rootResults.some(r => r.other);
      const bucket = local.any ? 'Unknown' : collateral && other ? 'Mixed' : collateral && rootResults.every(r => r.collateral) ? 'PureCollateral' : 'KnownNonCollateral';
      const costAttribution = local.any ? 'unattributed' : applications.size === 1 && !applications.has('0') && events.size <= 1 ? 'singleton-application' : 'shared-multi-event';
      attempts.push({ windowId: window.windowId, inputSequence: execution.InputSequence, attemptOrdinal: execution.AttemptOrdinal, executionRecordSequence: execution.Sequence, replay: execution.Replay, outcome: execution.Outcome, elapsedNanos: execution.HasElapsed ? execution.ElapsedNanos : null, bucket, knownCauseBits: causes, roots: rootResults, applications: [...applications], physicalPublications: [...events], costAttribution, reasons: local.values });
    }
    requireThat(consumedLinks.size === index.links.size || reasons.any, 'orphan attempt link without execution loss');
    windowReports.push({ windowId: window.windowId, complete: !reasons.any, reasons: reasons.values, observedAttempts: entered.length, executionSummaryTrusted, causalSummaryTrusted, executionFinal: window.executionFinal ?? null, causalFinal: window.causalFinal ?? null });
  }
  for (const id of grouped.keys()) requireThat(streamKinds.has(id), 'unmapped raw stream');
  const summary = aggregate(attempts);
  const totalReplay = windowReports.reduce((sum, w) => w.executionFinal?.ReplayAttempts === undefined ? sum : sum + u64(w.executionFinal.ReplayAttempts), 0n);
  const totalReplayNanos = windowReports.reduce((sum, w) => w.executionFinal?.ReplayElapsedNanos === undefined ? sum : sum + u64(w.executionFinal.ReplayElapsedNanos), 0n);
  const exactDenominator = windowReports.every(w => w.executionSummaryTrusted);
  const totalFirstNanos = windowReports.reduce((sum, w) => w.executionFinal?.FirstElapsedNanos === undefined ? sum : sum + u64(w.executionFinal.FirstElapsedNanos), 0n);
  const executionTotal = windowReports.reduce((sum, w) => w.executionFinal ? sum + u64(w.executionFinal.FirstAttempts) + u64(w.executionFinal.ReplayAttempts) : sum, 0n);
  const timedTotal = windowReports.reduce((sum, w) => w.executionFinal ? sum + u64(w.executionFinal.TimedFirstAttempts) + u64(w.executionFinal.TimedReplayAttempts) : sum, 0n);
  const measuredTotalNanos = totalFirstNanos + totalReplayNanos;
  const allExecutionTimeKnown = exactDenominator && windowReports.every(w => w.executionFinal.FirstAttempts === w.executionFinal.TimedFirstAttempts && w.executionFinal.ReplayAttempts === w.executionFinal.TimedReplayAttempts && w.executionFinal.ClockFailures === '0');
  const collateralApplications = new Set();
  for (const a of attempts) {
    work.charge(); if (!a.replay || a.bucket !== 'PureCollateral') continue;
    for (const applicationId of a.applications) {
      work.charge(); const id = key(a.windowId, applicationId); if (exposedApplications.has(id)) collateralApplications.add(id);
    }
  }
  const applicationSummaryAvailable = windowReports.every(w => w.causalSummaryTrusted && w.causalFinal.ClosureIncomplete === false && w.causalFinal.ActiveSnapshotAtStop === false && w.causalFinal.RootsOmitted === '0' && w.causalFinal.DiagnosticFaults === '0');
  const exposedCount = windowReports.reduce((sum, w) => w.causalFinal ? sum + u64(w.causalFinal.ApplicationsWithOutstandingBeforeCoverage) : sum, 0n);
  const provenApplicationCounts = new Map();
  for (const id of collateralApplications) { work.charge(); const windowId = JSON.parse(id)[0]; provenApplicationCounts.set(windowId, (provenApplicationCounts.get(windowId) ?? 0) + 1); }
  const frequency = manifest.windows.map(w => {
    work.charge();
    const measurement = w.measurement;
    const supported = measurement?.source === 'host-monotonic-duration' && nonempty(measurement.evidence);
    const duration = supported ? u64(measurement.durationNanos) : 0n;
    const count = provenApplicationCounts.get(w.windowId) ?? 0;
    return { windowId: w.windowId, provenApplications: String(count), perMinute: { numerator: (BigInt(count) * 60000000000n).toString(), denominator: duration > 0n ? duration.toString() : null, meaning: 'Lower-bound proven application frequency within this explicitly measured managed window; unavailable without a positive Host duration. No cross-process clock subtraction.' } };
  });
  const applicationCosts = new Map();
  for (const a of attempts) {
    work.charge(); if (a.costAttribution !== 'singleton-application') continue;
    const id = key(a.windowId, a.applications[0]);
    if (!applicationCosts.has(id)) applicationCosts.set(id, { windowId: a.windowId, applicationId: a.applications[0], attempts: [] });
    applicationCosts.get(id).attempts.push(a);
  }
  const costs = {
    singletonApplications: [...applicationCosts.values()].map(({ windowId, applicationId, attempts: associated }) => ({ windowId, applicationId, summary: aggregate(associated) })),
    sharedMultiEvent: aggregate(attempts.filter(a => a.costAttribution === 'shared-multi-event')),
    unattributed: aggregate(attempts.filter(a => a.costAttribution === 'unattributed')),
  };
  return { format: 'lumio-prediction-analysis', version: 1, status: windowReports.every(w => w.complete) ? 'Analyzed' : 'Incomplete', interpretation: 'Observed provenance-associated costs only; no counterfactual savings or deployed R654 completion.', windows: windowReports, attempts, summary,
    costs, coverage: { observedAttempts: attempts.length, classifiedAttempts: attempts.filter(a => a.bucket !== 'Unknown').length,
      finalObservedAttempts: exactDenominator ? executionTotal.toString() : null, finalTimedAttempts: exactDenominator ? timedTotal.toString() : null, missingElapsedAttempts: exactDenominator && executionTotal >= timedTotal ? (executionTotal - timedTotal).toString() : null,
      pureCollateralTimeShare: { numerator: summary.replay.buckets.PureCollateral.observedElapsedNanos, denominator: allExecutionTimeKnown && measuredTotalNanos > 0n ? measuredTotalNanos.toString() : null, meaning: 'Primary: proven pure-collateral replay time / all first-plus-replay execution time. Unavailable if any attempt lacks timing, timing status is incomplete, or denominator is zero; never substitute a timed-subset denominator.' },
      observedTimedExecutionShare: { numerator: summary.replay.buckets.PureCollateral.observedElapsedNanos, denominator: exactDenominator && measuredTotalNanos > 0n ? measuredTotalNanos.toString() : null, meaning: 'Separate measured subset: pure replay elapsed / observed timed first-plus-replay elapsed. Not a guaranteed lower bound on the all-execution share when any time is missing.' },
      collateralApplicationShare: { numerator: String(collateralApplications.size), denominator: applicationSummaryAvailable && exposedCount > 0n ? exposedCount.toString() : null, meaning: 'Deduplicated proven applications with pure replay and positive pre-coverage exposure / final ApplicationsWithOutstandingBeforeCoverage. Numerator is a lower bound, not an inferred zero frequency when detail is missing.' },
      applicationFrequency: frequency,
      replayPureLowerBoundRatio: { numerator: String(summary.replay.buckets.PureCollateral.attempts), denominator: exactDenominator && totalReplay > 0n ? totalReplay.toString() : null, meaning: 'Exact rational lower bound over final observed replay attempts; null denominator means unavailable or zero. Never divide by classified subset.' },
      timedReplayPureLowerBoundRatio: { numerator: summary.replay.buckets.PureCollateral.observedElapsedNanos, denominator: exactDenominator && totalReplayNanos > 0n ? totalReplayNanos.toString() : null, meaning: 'Secondary: over final timed replay nanoseconds only, not all replay time; untimed costs remain missing.' } } };
}
