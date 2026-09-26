// Every voxel-world-v1 meshOutput constant the browser side needs, in one place.
//
// The numbers come from the engine's generated module (`voxel-world-generated.mjs`, a
// verbatim copy of the architecture repository's `engine/wire/generated/voxel-world-generated.mjs`
// kept current by `node eng/sync-voxel-world-generated.mjs`). This file only reshapes
// them into the names Render / Assets use. What is still written here is either a
// Client choice the contract leaves to the renderer (index pattern, staging alignment)
// or a value generate-abi does not emit yet (normal codes, cross-quad corner UVs, the
// wasm staging / last-error entries); `mesh-layout.test.mjs` checks those against the
// contract JSON.

import {
  FACE_TEXTURE_RESERVED_LAYER,
  FACE_TEXTURE_SLOTS,
  MESH_ERROR_IDS,
  MESH_FORMAT_VERSION as GENERATED_MESH_FORMAT_VERSION,
  MESH_HEADER_BYTES as GENERATED_MESH_HEADER_BYTES,
  MESH_HEADER_OFFSETS,
  MESH_SEGMENT_ORDER,
  MESH_VERTEX_BITS,
  MESH_VERTEX_STRIDE_BYTES,
  SECTION_EXTENT,
  SECTION_Y_MAX as GENERATED_SECTION_Y_MAX,
  WASM_ABI_VERSION as GENERATED_WASM_ABI_VERSION,
  WASM_ENTRIES,
  WASM_RETURN_CODES,
  WASM_STRUCTS,
} from "./voxel-world-generated.mjs";

/// `lumio_voxel_abi_version()` the mesh entries need (meshOutput.wasmInterop.abiVersion).
export const WASM_ABI_VERSION = GENERATED_WASM_ABI_VERSION;

// ---- buffer (meshOutput.buffer) -------------------------------------------------

export const MESH_HEADER_BYTES = GENERATED_MESH_HEADER_BYTES;
export const MESH_FORMAT_VERSION = GENERATED_MESH_FORMAT_VERSION;

/// Header fields, byte offsets from the first header byte, little endian.
export const MESH_HEADER_FIELDS = MESH_HEADER_OFFSETS;

/// Segment order in the buffer, and the order the passes draw them (meshOutput.segments.order).
export const SEGMENTS = MESH_SEGMENT_ORDER;

// ---- vertex (meshOutput.vertex) ---------------------------------------------------

export const VERTEX_STRIDE = MESH_VERTEX_STRIDE_BYTES;
export const QUAD_VERTICES = 4;
export const QUAD_BYTES = QUAD_VERTICES * VERTEX_STRIDE;
/// Shared index pattern per quad; quad q adds 4q (meshOutput.segments.quads).
export const QUAD_INDEX_PATTERN = Object.freeze([0, 1, 2, 0, 2, 3]);

/// Two little-endian u32 words per vertex, in the generated field order.
export const VERTEX_BITS = Object.freeze(
  Object.entries(MESH_VERTEX_BITS).map(([field, bits]) => Object.freeze({
    field, word: bits.word, bitOffset: bits.offset, bitWidth: bits.width,
  })),
);

/// Position unit: 1/16 block (meshOutput.vertex.position).
export const POSITION_UNITS_PER_BLOCK = 16;
/// Section edge in blocks.
export const SECTION_BLOCKS = SECTION_EXTENT;
/// Section keys: y is 0..15.
export const SECTION_Y_MAX = GENERATED_SECTION_Y_MAX;

/// Normal codes; 0..5 have the order of the first six face table slots, 6 is a cross quad.
export const NORMAL = Object.freeze(Object.fromEntries(FACE_TEXTURE_SLOTS.map((slot, code) => [slot, code])));
/// AO level meaning "not occluded" (the only value non-FullCube faces carry).
export const AO_UNOCCLUDED = 3;
/// Cross-quad corner number → (u, v) (meshOutput.vertex.aoOrCorner).
export const CROSS_CORNER_UV = Object.freeze([[0, 1], [1, 1], [1, 0], [0, 0]].map(Object.freeze));

// ---- face texture table (meshOutput.faceTextureTable) -----------------------------

export const FACE_SLOTS = FACE_TEXTURE_SLOTS;
/// Row i is blockType FIRST_CATALOG_BLOCK_TYPE + i.
export const FIRST_CATALOG_BLOCK_TYPE = 256;
export const LAYER_MISSING = FACE_TEXTURE_RESERVED_LAYER;
export const LAYER_MAX = 0xffff;

// ---- wasm interop (meshOutput.wasmInterop) ----------------------------------------

const entry = (name) => {
  if (!WASM_ENTRIES.includes(name)) throw new Error(`voxel-world-generated.mjs lists no wasm entry ${name}`);
  return name;
};

/// Mesh entries come from the generated list; the staging / last-error entries are the
/// wasm crate's own ABI (not in the contract's entry table yet).
export const WASM_ENTRY = Object.freeze({
  abiVersion: "lumio_voxel_abi_version",
  alloc: "lumio_voxel_alloc",
  free: "lumio_voxel_free",
  lastErrorLen: "lumio_voxel_last_error_len",
  lastError: "lumio_voxel_last_error",
  mesherCreate: entry("lumio_voxel_mesher_create"),
  mesherDestroy: entry("lumio_voxel_mesher_destroy"),
  meshSection: entry("lumio_voxel_mesh_section"),
  meshRelease: entry("lumio_voxel_mesh_release"),
  remeshPendingCount: entry("lumio_voxel_remesh_pending_count"),
  drainRemesh: entry("lumio_voxel_drain_remesh"),
});

/// `LUMIO_VOXEL_STAGING_ALIGN`.
export const STAGING_ALIGN = 8;

const meshResult = WASM_STRUCTS.LumioVoxelMeshResult;
const sectionKey = WASM_STRUCTS.LumioVoxelSectionKey;
/// `LumioVoxelMeshResult` (16 bytes).
export const MESH_RESULT = Object.freeze({
  bytes: meshResult.bytes,
  handle: meshResult.fields.handle.offset,
  ptr: meshResult.fields.ptr.offset,
  len: meshResult.fields.len.offset,
});
/// `LumioVoxelSectionKey` (12 bytes).
export const SECTION_KEY = Object.freeze({
  bytes: sectionKey.bytes,
  sectionX: sectionKey.fields.section_x.offset,
  sectionY: sectionKey.fields.section_y.offset,
  sectionZ: sectionKey.fields.section_z.offset,
});

/// Return codes (meshOutput.wasmInterop.conventions); branch on the error id string, not on these.
export const WASM_STATUS = Object.freeze({
  ok: WASM_RETURN_CODES.success,
  failed: WASM_RETURN_CODES.anyOtherFailure,
  invalidHandle: WASM_RETURN_CODES.InvalidHandle,
  bufferTooSmall: WASM_RETURN_CODES.BufferTooSmall,
  invalidArgument: WASM_RETURN_CODES.InvalidArgument,
});

/// Error id strings the mesh driver branches on.
export const WASM_ERROR = Object.freeze({
  meshHandleAlreadyReleased: MESH_ERROR_IDS.MESH_HANDLE_ALREADY_RELEASED,
  sectionUnavailable: MESH_ERROR_IDS.SECTION_UNAVAILABLE,
  sectionYOutOfRange: MESH_ERROR_IDS.SECTION_Y_OUT_OF_RANGE,
  invalidHandle: "InvalidHandle",
  bufferTooSmall: "BufferTooSmall",
  invalidArgument: "InvalidArgument",
});
