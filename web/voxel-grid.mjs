// Browser voxel grid over the VoxelEngine wasm32 C ABI (ADR-078).
//
// 决策 1: the voxel code in the browser IS VoxelEngine's Rust, built for
// wasm32-unknown-unknown. This module writes no Section store, no decoder and
// no mesher. Every cell it reports comes out of `lumio_voxel_read_box`; the
// bytes it feeds in are the DS SectionFrame payload the C# replica host handed
// over verbatim. Section data is never carried back out of wasm to be
// interpreted here.
//
// 决策 3: this instance has its own `WebAssembly.Memory`. The .NET replica runs
// in its own, and the two are never merged and never share a codec.
//
// 决策 4.3: `Memory.grow` detaches every `ArrayBuffer` view that existed before
// it. Every helper below therefore re-takes `exports.memory.buffer` AFTER each
// call into wasm and never holds a view across one.

/// ABI revision this page was written against; `lumio_voxel_abi_version` must match.
/// ABI 2 (ADR-124, voxel-world-v1 meshOutput.wasmInterop.abiVersion): `world_create`
/// takes the catalog v2 JSON, deliveries update lighting and mark Sections to remesh.
/// `voxel-grid.test.mjs` checks this against the engine's generated WASM_ABI_VERSION.
export const LUMIO_VOXEL_ABI_VERSION = 2;

/// `lumio_voxel_contracts::voxel_world::BLOCK_TYPE_AIR`. The one block TYPE with a
/// contract-wide meaning; every other type is game data this page never hardcodes.
export const BLOCK_TYPE_AIR = 0;

/// `BLOCK_STATE_BITS`: a block id is `BlockType << 8 | BlockState`. Contract
/// layout, not game data — so the page may split it, and only ever into those
/// two halves.
export const BLOCK_STATE_BITS = 8;

export function blockTypeOf(blockId) {
  return blockId >>> BLOCK_STATE_BITS;
}

export function blockStateOf(blockId) {
  return blockId & ((1 << BLOCK_STATE_BITS) - 1);
}

/// Per-column surface states `readSurface` reports.
export const SURFACE_LOADING = 0;
export const SURFACE_AIR = 1;
export const SURFACE_BLOCK = 2;

const LUMIO_VOXEL_OK = 0;

// `LUMIO_VOXEL_STAGING_ALIGN`; every repr(C) out-parameter needs it.
const STAGING_ALIGN = 8;
const DIGEST_BYTES = 32;
// sizeof(LumioVoxelDeliveryResult) / LumioVoxelBoxRead, both 8-byte aligned.
const DELIVERY_RESULT_BYTES = 96;
const BOX_READ_BYTES = 16;

// A presence byte `read_box` never writes. `read_box` only fills the cells its
// segments cover, and presence index 0 is `Ready` — leaving a stale or zeroed
// byte in place would turn "we were not told" into "resolved air", which is
// exactly what ADR-078 forbids. Anything that comes back as the sentinel (or as
// an index outside the presence table) is treated as unresolved.
const PRESENCE_UNWRITTEN = 0xff;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function align(value) {
  return (value + (STAGING_ALIGN - 1)) & ~(STAGING_ALIGN - 1);
}

/// Read the error id string the last failing call recorded. ADR-078: branch on
/// this string, never on the negative status number.
function lastError(exports) {
  const length = exports.lumio_voxel_last_error_len();
  if (!length) return "";
  const ptr = exports.lumio_voxel_alloc(length);
  if (!ptr) return "staging_alloc_failed";
  try {
    const written = exports.lumio_voxel_last_error(ptr, length);
    if (written < 0) return "last_error_unreadable";
    // Fresh view: the alloc and the copy above may both have grown memory.
    return decoder.decode(new Uint8Array(exports.memory.buffer, ptr, written));
  } finally {
    exports.lumio_voxel_free(ptr, length);
  }
}

function fail(exports, operation) {
  const id = lastError(exports);
  return new Error(id ? `${operation}:${id}` : operation);
}

/// Names of the contract's `SECTION_PRESENCE` table, read out of wasm so the
/// page never hardcodes the indices.
function readPresenceNames(exports) {
  const capacity = 64;
  const ptr = exports.lumio_voxel_alloc(capacity);
  if (!ptr) throw new Error("presence_names:staging_alloc_failed");
  const names = [];
  try {
    for (let index = 0; index < capacity; index += 1) {
      const written = exports.lumio_voxel_presence_name(index, ptr, capacity);
      if (written < 0) break;
      names.push(decoder.decode(new Uint8Array(exports.memory.buffer, ptr, written)));
    }
  } finally {
    exports.lumio_voxel_free(ptr, capacity);
  }
  if (!names.length) throw new Error("presence_names:empty");
  return names;
}

/// The catalog v2 JSON as bytes: a string, bytes, or the parsed envelope object.
export function catalogJsonBytes(catalog) {
  if (catalog instanceof Uint8Array) return catalog;
  if (catalog instanceof ArrayBuffer) return new Uint8Array(catalog);
  if (typeof catalog === "string") return encoder.encode(catalog);
  if (catalog && typeof catalog === "object") return encoder.encode(JSON.stringify(catalog));
  return null;
}

function createWorld(exports, options) {
  const worldId = encoder.encode(options.worldId);
  const contextId = encoder.encode(options.contextId);
  const role = encoder.encode(options.role);
  const capabilities = encoder.encode(options.capabilities);
  const catalog = options.catalogJson;
  // out_handle at 0 (u32), config digest at 8, then the four strings and the catalog.
  const handleOffset = 0;
  const digestOffset = 8;
  const stringsOffset = digestOffset + DIGEST_BYTES;
  const total = stringsOffset + worldId.length + contextId.length + role.length + capabilities.length + catalog.length;
  const base = exports.lumio_voxel_alloc(total);
  if (!base) throw new Error("world_create:staging_alloc_failed");
  try {
    // Fresh view after the alloc; nothing below re-enters wasm before the call.
    const bytes = new Uint8Array(exports.memory.buffer);
    bytes.fill(0, base, base + stringsOffset);
    bytes.set(options.configHash, base + digestOffset);
    let cursor = base + stringsOffset;
    const put = (value) => {
      bytes.set(value, cursor);
      const at = cursor;
      cursor += value.length;
      return at;
    };
    const worldIdPtr = put(worldId);
    const contextIdPtr = put(contextId);
    const rolePtr = put(role);
    const capabilitiesPtr = put(capabilities);
    const catalogPtr = put(catalog);
    // ABI 2: the catalog v2 JSON rides after max_receipts (required; the world validates
    // every delivered BlockState against it, and the mesher / lighting read it).
    const status = exports.lumio_voxel_world_create(
      worldIdPtr, worldId.length,
      contextIdPtr, contextId.length,
      rolePtr, role.length,
      capabilitiesPtr, capabilities.length,
      base + digestOffset,
      options.maxPinnedRevisions,
      options.maxReceipts,
      catalogPtr, catalog.length,
      base + handleOffset,
    );
    if (status !== LUMIO_VOXEL_OK) throw fail(exports, "world_create");
    // Fresh view: the create above allocated the whole world inside this memory.
    return new DataView(exports.memory.buffer).getUint32(base + handleOffset, true);
  } finally {
    exports.lumio_voxel_free(base, total);
  }
}

/// One `SectionFrame` the C# host decoded, fed into the Rust world.
///
/// `header` carries the contract envelope fields; `digest` is the frame's own
/// `payloadSha256` (32 bytes) and `payload` its bytes. Neither is inspected
/// here — the digest is passed straight through as ADR-078 决策 1 requires, so
/// no second SHA-256 lands in the page.
function deliverSection(exports, handle, requested, header, digest, payload) {
  const key = `${header.sectionX}:${header.sectionY}:${header.sectionZ}`;
  if (!requested.has(key)) {
    // A Section that was never requested refuses delivery. One request per
    // Section key: a later revision of a Section already in hand is delivered
    // straight onto the Ready one.
    const status = exports.lumio_voxel_request_section(
      handle, header.sectionX, header.sectionY, header.sectionZ,
    );
    if (status !== LUMIO_VOXEL_OK) throw fail(exports, "request_section");
    requested.add(key);
  }

  const encoding = encoder.encode(header.encoding);
  const resultOffset = 0;
  const digestOffset = DELIVERY_RESULT_BYTES;
  const encodingOffset = digestOffset + DIGEST_BYTES;
  const payloadOffset = align(encodingOffset + encoding.length);
  const total = payloadOffset + payload.length;
  const base = exports.lumio_voxel_alloc(total);
  if (!base) throw new Error("deliver_section:staging_alloc_failed");
  try {
    // Fresh view after the alloc.
    const bytes = new Uint8Array(exports.memory.buffer);
    bytes.fill(0, base + resultOffset, base + digestOffset);
    bytes.set(digest, base + digestOffset);
    bytes.set(encoding, base + encodingOffset);
    bytes.set(payload, base + payloadOffset);
    const status = exports.lumio_voxel_deliver_section(
      handle,
      header.sectionX, header.sectionY, header.sectionZ,
      BigInt(header.sectionRevision),
      base + encodingOffset, encoding.length,
      header.payloadLength,
      base + digestOffset,
      header.hasBaseSectionRevision ? 1 : 0,
      BigInt(header.baseSectionRevision ?? 0),
      base + payloadOffset, payload.length,
      base + resultOffset,
    );
    if (status !== LUMIO_VOXEL_OK) throw fail(exports, "deliver_section");
    // Fresh view: the delivery grew the resident Section set inside this memory.
    const view = new DataView(exports.memory.buffer);
    return {
      sectionX: view.getInt32(base + resultOffset, true),
      sectionY: view.getUint32(base + resultOffset + 4, true),
      sectionZ: view.getInt32(base + resultOffset + 8, true),
      sectionRevision: view.getBigUint64(base + resultOffset + 16, true).toString(),
      worldRevision: view.getBigUint64(base + resultOffset + 24, true).toString(),
    };
  } finally {
    exports.lumio_voxel_free(base, total);
  }
}

/// Opens the Rust voxel world for one spectator page.
///
/// `fetchImpl` and `instantiate` are injected so the node test harness can drive
/// the very same module against the very same `.wasm`.
export async function openVoxelGrid(options) {
  const {
    wasmUrl = "./lumio_voxel_wasm.wasm",
    fetchImpl = typeof fetch === "function" ? fetch : null,
    instantiate = typeof WebAssembly === "object" ? WebAssembly.instantiate : null,
    worldId = "spectator-replica",
    contextId = "spectator-browser",
    // A browser observer is a Replica. `Native,ReferenceVoxel` is the capability
    // pair the ABI documents for one.
    role = "Replica",
    capabilities = "Native,ReferenceVoxel",
    // The page has no host config digest of its own: nothing on the DS downlink
    // carries one, and Section admission does not check it. It declares a zero
    // digest rather than inventing a value that would look authoritative.
    configHash = new Uint8Array(DIGEST_BYTES),
    maxPinnedRevisions = 64,
    maxReceipts = 4096,
    // The official block catalog v2 (the game's `official-catalog.json`, the same bytes the
    // DS world was created with). ABI 2 has no world without one.
    catalogJson,
  } = options ?? {};

  const catalogBytes = catalogJsonBytes(catalogJson);
  if (!catalogBytes || catalogBytes.length === 0) {
    return unavailableGrid("catalog_json_required");
  }
  if (!fetchImpl || !instantiate) {
    return unavailableGrid("wasm_host_unavailable");
  }

  let exports;
  try {
    const response = await fetchImpl(wasmUrl);
    if (!response || response.ok === false) {
      return unavailableGrid(`wasm_fetch_failed:${response ? response.status : "no_response"}`);
    }
    const bytes = await response.arrayBuffer();
    // No imports to satisfy: the module is a freestanding cdylib.
    const instantiated = await instantiate(bytes, {});
    exports = (instantiated.instance ?? instantiated).exports;
  } catch (error) {
    return unavailableGrid(`wasm_load_failed:${error && error.message ? error.message : error}`);
  }

  try {
    const abiVersion = exports.lumio_voxel_abi_version();
    if (abiVersion !== LUMIO_VOXEL_ABI_VERSION) {
      return unavailableGrid(`abi_version_mismatch:${abiVersion}`);
    }
    const presenceNames = readPresenceNames(exports);
    const handle = createWorld(exports, {
      worldId, contextId, role, capabilities, configHash, maxPinnedRevisions, maxReceipts,
      catalogJson: catalogBytes,
    });
    return liveGrid(exports, handle, presenceNames, abiVersion);
  } catch (error) {
    return unavailableGrid(error && error.message ? error.message : String(error));
  }
}

/// A grid that knows nothing: no world booted, or the world was torn down with
/// the session. It answers every column "loading" and no column "air", so a page
/// that holds one paints honestly instead of branching on null.
export function unavailableVoxelGrid(reason) {
  return unavailableGrid(reason);
}

function unavailableGrid(reason) {
  return {
    status: "unavailable",
    error: reason,
    abiVersion: 0,
    presenceNames: [],
    wasm: null,
    sections: () => [],
    sectionRevision: () => null,
    worldRevision: null,
    deliver() {
      return { ok: false, error: reason };
    },
    // No world, so no cell is known. Every column reports loading; none is air.
    readSurface(box) {
      const width = box.maxX - box.minX + 1;
      const depth = box.maxZ - box.minZ + 1;
      return {
        width,
        depth,
        blockIds: new Uint32Array(width * depth),
        states: new Uint8Array(width * depth),
        counts: { block: 0, air: 0, loading: width * depth },
        layersRead: 0,
        error: reason,
      };
    },
    destroy() {},
  };
}

function liveGrid(exports, handle, presenceNames, abiVersion) {
  const requested = new Set();
  const delivered = new Map();
  // Which presence names mean "this cell's block id is meaningful". Resolved
  // from the table read out of wasm, not from hardcoded indices.
  const resolvedPresence = new Set(
    presenceNames
      .map((name, index) => (name === "Ready" || name === "Unchanged" ? index : -1))
      .filter((index) => index >= 0),
  );

  let alive = true;
  let worldRevision = null;
  // Staging reused across paints, resized on demand. Both arrays are page-owned
  // (`lumio_voxel_alloc`), so they are freed on destroy.
  let staging = null;

  function ensureStaging(cells) {
    // block_ids: u32 per cell (8-aligned base), presence: 1 byte per cell,
    // then the LumioVoxelBoxRead summary.
    const idsBytes = cells * 4;
    const presenceOffset = align(idsBytes);
    const summaryOffset = align(presenceOffset + cells);
    const total = summaryOffset + BOX_READ_BYTES;
    if (staging && staging.cells >= cells) return staging;
    if (staging) exports.lumio_voxel_free(staging.base, staging.total);
    const base = exports.lumio_voxel_alloc(total);
    if (!base) throw new Error("read_box:staging_alloc_failed");
    staging = { base, total, cells, idsBytes, presenceOffset, summaryOffset };
    return staging;
  }

  return {
    status: "ready",
    error: null,
    abiVersion,
    presenceNames,
    /// The wasm exports and this world's handle, for the block renderer's mesh driver
    /// (Client/Render `createBlockScene({ exports, world })`): meshing reads this very
    /// world, so there is exactly one Section store in the page.
    get wasm() {
      return alive ? { exports, world: handle } : null;
    },
    /// Current SectionRevision (decimal string) of a delivered Section, by `"x:y:z"` or
    /// `"s:x:y:z"`, or null. Feeds the renderer's revision-lag warning.
    sectionRevision(key) {
      const canonical = key.startsWith("s:") ? key : `s:${key}`;
      return delivered.get(canonical) ?? null;
    },
    get worldRevision() {
      return worldRevision;
    },
    sections() {
      return [...delivered.entries()].map(([key, revision]) => ({ key, revision }));
    },

    deliver(header, digest, payload) {
      if (!alive) return { ok: false, error: "world_destroyed" };
      try {
        const result = deliverSection(exports, handle, requested, header, digest, payload);
        delivered.set(`s:${result.sectionX}:${result.sectionY}:${result.sectionZ}`, result.sectionRevision);
        worldRevision = result.worldRevision;
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    },

    /// One top-down pass over `box`: the topmost non-air block per column.
    ///
    /// One `lumio_voxel_read_box` per Y layer, highest first, iterating y outer
    /// / z middle / x inner exactly as the ABI documents. A column becomes AIR
    /// only when every layer answered a resolved air cell. The moment a layer
    /// answers Pending / Unavailable — or a presence byte `read_box` never wrote
    /// — that column stays LOADING and is never painted as air.
    readSurface(box) {
      const width = box.maxX - box.minX + 1;
      const depth = box.maxZ - box.minZ + 1;
      const cells = width * depth;
      const blockIds = new Uint32Array(cells);
      const states = new Uint8Array(cells);
      const unresolved = new Uint8Array(cells);
      if (!alive) {
        return { width, depth, blockIds, states, counts: { block: 0, air: 0, loading: cells }, layersRead: 0, error: "world_destroyed" };
      }

      let layersRead = 0;
      let error = null;
      try {
        const slot = ensureStaging(cells);
        let pending = cells;
        for (let y = box.maxY; y >= box.minY && pending > 0; y -= 1) {
          // Fresh view before writing the sentinel; the previous iteration
          // called into wasm.
          new Uint8Array(exports.memory.buffer).fill(
            PRESENCE_UNWRITTEN,
            slot.base + slot.presenceOffset,
            slot.base + slot.presenceOffset + cells,
          );
          const status = exports.lumio_voxel_read_box(
            handle,
            box.minX, y, box.minZ,
            box.maxX, y, box.maxZ,
            slot.base, slot.base + slot.presenceOffset, cells,
            slot.base + slot.summaryOffset,
          );
          if (status !== LUMIO_VOXEL_OK) throw fail(exports, "read_box");
          layersRead += 1;
          // Fresh views after the call: read_box may have grown memory.
          const buffer = exports.memory.buffer;
          const ids = new Uint32Array(buffer, slot.base, cells);
          const presence = new Uint8Array(buffer, slot.base + slot.presenceOffset, cells);
          for (let i = 0; i < cells; i += 1) {
            if (states[i] !== SURFACE_LOADING) continue;
            if (!resolvedPresence.has(presence[i])) {
              unresolved[i] = 1;
              continue;
            }
            const id = ids[i];
            // Air is a block TYPE; the state half never makes a cell solid.
            if (blockTypeOf(id) === BLOCK_TYPE_AIR) continue;
            states[i] = SURFACE_BLOCK;
            blockIds[i] = id;
            pending -= 1;
          }
        }
      } catch (readError) {
        error = readError && readError.message ? readError.message : String(readError);
        // Anything not already decided stays LOADING: a failed read is not air.
        unresolved.fill(1);
      }

      // A column is air only because every layer was READ and answered resolved
      // air. If no layer was read at all, nothing was asked and nothing is known.
      if (layersRead === 0) unresolved.fill(1);

      let block = 0;
      let air = 0;
      let loading = 0;
      for (let i = 0; i < cells; i += 1) {
        if (states[i] === SURFACE_BLOCK) {
          block += 1;
        } else if (unresolved[i]) {
          loading += 1;
        } else {
          states[i] = SURFACE_AIR;
          air += 1;
        }
      }
      return { width, depth, blockIds, states, counts: { block, air, loading }, layersRead, error };
    },

    destroy() {
      if (!alive) return;
      alive = false;
      if (staging) {
        exports.lumio_voxel_free(staging.base, staging.total);
        staging = null;
      }
      exports.lumio_voxel_world_destroy(handle);
    },
  };
}
