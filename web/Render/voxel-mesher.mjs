// Drives the VoxelEngine wasm mesher (voxel-world-v1 meshOutput.wasmInterop, ADR-124 D6).
//
// The mesher is VoxelEngine's Rust (ADR-078): this module only calls it, uploads
// what it returns and hands the handle straight back. Three rules from
// meshOutput.releaseAndRevision hold here:
// 1. every handle is released right after its upload, or right away when the mesh
//    is discarded;
// 2. a mesh older than the one on screen is discarded (Render decides by
//    sectionRevision / meshSequence);
// 3. any call may grow linear memory and detach every view: `exports.memory.buffer`
//    is re-taken after each call, and no wasm entry runs between taking it and the
//    upload that reads it.
//
// Lighting needs no call of its own: `lumio_voxel_deliver_section` updates it and
// marks the Sections to remesh. Call `pump()` after deliveries (or once per frame).

import { parseMeshHeader } from "./mesh-format.mjs";
import { MESH_RESULT, SECTION_KEY, WASM_ABI_VERSION, WASM_ENTRY, WASM_ERROR, WASM_STATUS } from "./mesh-layout.mjs";
import { sectionKey } from "./block-renderer.mjs";

const decoder = new TextDecoder();

/// How many SectionRevisions the mesh on screen may trail the world by before the driver
/// warns (meshOutput.releaseAndRevision: the budget belongs to the implementing repo).
/// Lighting-only remeshes keep the revision, so a lag means real block changes are not
/// shown yet — typically a frame loop that stopped pumping or meshing that keeps failing.
export const DEFAULT_REVISION_LAG_BUDGET = 4;

// Staging owned by the driver: the mesh result struct, then one u32 out-parameter.
const STAGING_RESULT = 0;
const STAGING_U32 = MESH_RESULT.bytes;
const STAGING_BYTES = STAGING_U32 + 8;

const REQUIRED_ENTRIES = [
  "abiVersion", "alloc", "free", "lastErrorLen", "lastError",
  "mesherCreate", "mesherDestroy", "meshSection", "meshRelease", "remeshPendingCount", "drainRemesh",
];

function defaultWarn(warning) {
  // eslint-disable-next-line no-console
  console.warn(warning.message, warning);
}

/// `exports`: the lumio-voxel-wasm instance exports (ABI 2). `world`: the world
/// handle the page created with the catalog v2 JSON (`lumio_voxel_world_create`).
/// `faceTable`: `Uint16Array`, catalog rows x 7 (`buildBlockTextures`).
/// `renderer`: `createBlockRenderer`.
/// `worldRevisionOf(key)`: optional; the world's current SectionRevision for a renderer
/// key `"x:y:z"` (the page's delivery bookkeeping), or null when unknown. With it the
/// driver warns once per Section when the mesh on screen trails the world by more than
/// `revisionLagBudget` revisions, and once more when it has caught up again.
export function createMeshDriver({
  exports, world, faceTable, renderer, onWarning = defaultWarn,
  worldRevisionOf = null, revisionLagBudget = DEFAULT_REVISION_LAG_BUDGET,
}) {
  const call = (entry, ...args) => exports[WASM_ENTRY[entry]](...args);
  for (const entry of REQUIRED_ENTRIES) {
    if (typeof exports[WASM_ENTRY[entry]] !== "function") throw new Error(`wasm_entry_missing:${WASM_ENTRY[entry]}`);
  }
  const abiVersion = call("abiVersion");
  if (abiVersion !== WASM_ABI_VERSION) throw new Error(`abi_version_mismatch:${abiVersion}`);

  // The error id the last failing call recorded; branch on it, not on the number.
  function lastError() {
    const length = call("lastErrorLen");
    if (!length) return "";
    const ptr = call("alloc", length);
    if (!ptr) return "staging_alloc_failed";
    try {
      const written = call("lastError", ptr, length);
      if (written < 0) return "last_error_unreadable";
      return decoder.decode(new Uint8Array(exports.memory.buffer, ptr, written));
    } finally {
      call("free", ptr, length);
    }
  }

  function readU32(ptr) {
    return new DataView(exports.memory.buffer).getUint32(ptr, true);
  }

  const staging = call("alloc", STAGING_BYTES);
  if (!staging) throw new Error("staging_alloc_failed");

  function createMesher(table) {
    const bytes = table.length * 2;
    const ptr = call("alloc", bytes);
    if (!ptr) throw new Error("mesher_create:staging_alloc_failed");
    try {
      // Fresh view after the alloc; nothing re-enters wasm before mesher_create.
      const view = new DataView(exports.memory.buffer);
      for (let i = 0; i < table.length; i += 1) view.setUint16(ptr + i * 2, table[i], true);
      const status = call("mesherCreate", world, ptr, table.length, staging + STAGING_U32);
      if (status !== WASM_STATUS.ok) throw new Error(`mesher_create:${lastError() || status}`);
      return readU32(staging + STAGING_U32);
    } finally {
      // The mesher copied the table before returning.
      call("free", ptr, bytes);
    }
  }

  let mesher = createMesher(faceTable);
  let alive = true;

  const warn = (reason, key) => onWarning({
    reason,
    sectionKey: key ?? null,
    message: `block mesh${key ? ` ${key}` : ""}: ${reason}`,
  });

  function release(handle, key) {
    const status = call("meshRelease", mesher, handle);
    if (status !== WASM_STATUS.ok) warn(`mesh_release:${lastError() || status}`, key);
  }

  /// Meshes one Section and uploads it if it is newer than what is shown.
  /// Returns "uploaded" | "discarded" | "removed" | "unavailable" | "failed".
  function meshOne(x, y, z) {
    const key = sectionKey(x, y, z);
    const status = call("meshSection", mesher, x, y, z, staging + STAGING_RESULT);
    if (status !== WASM_STATUS.ok) {
      const id = lastError();
      if (id === WASM_ERROR.sectionUnavailable) {
        // Not on this client (never arrived, or left): drop whatever is shown.
        if (renderer.displayed(key)) {
          renderer.removeSection(x, y, z);
          return "removed";
        }
        return "unavailable";
      }
      warn(`mesh_section:${id || status}`, key);
      return "failed";
    }

    // Fresh memory after mesh_section; no wasm call until the upload is done.
    const memory = exports.memory.buffer;
    const view = new DataView(memory);
    const handle = view.getUint32(staging + STAGING_RESULT + MESH_RESULT.handle, true);
    const ptr = view.getUint32(staging + STAGING_RESULT + MESH_RESULT.ptr, true);
    const len = view.getUint32(staging + STAGING_RESULT + MESH_RESULT.len, true);
    let outcome;
    try {
      const parsed = parseMeshHeader(view, ptr, len);
      if (!parsed.ok) {
        warn(parsed.error, key);
        outcome = "failed";
      } else if (sectionKey(parsed.header.sectionX, parsed.header.sectionY, parsed.header.sectionZ) !== key) {
        warn(`mesh_section_key_mismatch:${parsed.header.sectionX}:${parsed.header.sectionY}:${parsed.header.sectionZ}`, key);
        outcome = "failed";
      } else {
        outcome = renderer.submitMesh(parsed.header, memory, ptr).uploaded ? "uploaded" : "discarded";
      }
    } finally {
      release(handle, key);
    }
    return outcome;
  }

  function drainKeys() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let status = call("remeshPendingCount", world, staging + STAGING_U32);
      if (status !== WASM_STATUS.ok) {
        warn(`remesh_pending_count:${lastError() || status}`);
        return [];
      }
      const count = readU32(staging + STAGING_U32);
      if (count === 0) return [];
      const bytes = count * SECTION_KEY.bytes;
      const ptr = call("alloc", bytes);
      if (!ptr) {
        warn("drain_remesh:staging_alloc_failed");
        return [];
      }
      try {
        status = call("drainRemesh", world, ptr, count, staging + STAGING_U32);
        if (status !== WASM_STATUS.ok) {
          const id = lastError();
          if (id === WASM_ERROR.bufferTooSmall) continue;
          warn(`drain_remesh:${id || status}`);
          return [];
        }
        // Fresh view after drain_remesh.
        const view = new DataView(exports.memory.buffer);
        const written = view.getUint32(staging + STAGING_U32, true);
        const keys = [];
        for (let i = 0; i < written; i += 1) {
          const at = ptr + i * SECTION_KEY.bytes;
          keys.push([
            view.getInt32(at + SECTION_KEY.sectionX, true),
            view.getUint32(at + SECTION_KEY.sectionY, true),
            view.getInt32(at + SECTION_KEY.sectionZ, true),
          ]);
        }
        return keys;
      } finally {
        call("free", ptr, bytes);
      }
    }
    warn("drain_remesh:BufferTooSmall");
    return [];
  }

  const emptyStats = () => ({ uploaded: 0, discarded: 0, removed: 0, unavailable: 0, failed: 0, lagging: 0 });

  const lagging = new Set();
  const budget = BigInt(revisionLagBudget);
  /// Compares every Section on screen with the world's revision; warns on entering and
  /// leaving the over-budget state, never every frame.
  function checkRevisionLag(stats) {
    if (typeof worldRevisionOf !== "function") return;
    for (const key of renderer.sectionKeys()) {
      const shown = renderer.displayed(key);
      const current = worldRevisionOf(key);
      if (!shown || current === null || current === undefined) continue;
      const lag = BigInt(current) - BigInt(shown.sectionRevision);
      if (lag > budget) {
        stats.lagging += 1;
        if (!lagging.has(key)) {
          lagging.add(key);
          warn(`mesh_revision_lag:${lag}>${budget}`, key);
        }
      } else if (lagging.delete(key)) {
        warn("mesh_revision_lag_recovered", key);
      }
    }
    for (const key of [...lagging]) if (!renderer.displayed(key)) lagging.delete(key);
  }

  return {
    get mesher() {
      return mesher;
    },

    /// Takes the Sections the wasm side marked for remeshing and meshes each.
    pump() {
      const stats = emptyStats();
      if (!alive) return stats;
      for (const [x, y, z] of drainKeys()) stats[meshOne(x, y, z)] += 1;
      checkRevisionLag(stats);
      return stats;
    },

    /// Meshes one Section now (for example after the page learns it arrived).
    remesh(x, y, z) {
      return alive ? meshOne(x, y, z) : "failed";
    },

    /// Material pack swap: new mesher with the new table, drop every shown mesh,
    /// regenerate every Section that was shown.
    replaceFaceTable(table) {
      if (!alive) throw new Error("mesh_driver_destroyed");
      const shown = renderer.sectionKeys().map((key) => key.split(":").map(Number));
      const next = createMesher(table);
      const status = call("mesherDestroy", mesher);
      if (status !== WASM_STATUS.ok) warn(`mesher_destroy:${lastError() || status}`);
      mesher = next;
      renderer.clear();
      const stats = emptyStats();
      for (const [x, y, z] of shown) stats[meshOne(x, y, z)] += 1;
      return stats;
    },

    destroy() {
      if (!alive) return;
      alive = false;
      const status = call("mesherDestroy", mesher);
      if (status !== WASM_STATUS.ok) warn(`mesher_destroy:${lastError() || status}`);
      call("free", staging, STAGING_BYTES);
    },
  };
}
