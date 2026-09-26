// Reading the mesh buffer the VoxelEngine mesher hands over (voxel-world-v1 meshOutput).
//
// Render only reads this format; it never builds or edits geometry (ADR-078).
// The layout itself lives in `mesh-layout.mjs`; the JS decoder here and the GLSL
// decoder the shader embeds are both generated from its bit table.

import {
  CROSS_CORNER_UV,
  MESH_FORMAT_VERSION,
  MESH_HEADER_BYTES,
  MESH_HEADER_FIELDS as F,
  NORMAL,
  POSITION_UNITS_PER_BLOCK,
  QUAD_BYTES,
  SEGMENTS,
  VERTEX_BITS,
  VERTEX_STRIDE,
} from "./mesh-layout.mjs";

export function decodeVertex(word0, word1) {
  const words = [word0 >>> 0, word1 >>> 0];
  const vertex = {};
  for (const bit of VERTEX_BITS) {
    vertex[bit.field] = (words[bit.word] >>> bit.bitOffset) & (2 ** bit.bitWidth - 1);
  }
  return vertex;
}

/// GLSL ES 3.00 statements declaring one `uint` per field from two `uint` words.
export function glslVertexDecode(word0 = "w0", word1 = "w1") {
  const names = [word0, word1];
  return VERTEX_BITS
    .map((bit) => `uint ${bit.field} = (${names[bit.word]} >> ${bit.bitOffset}u) & ${2 ** bit.bitWidth - 1}u;`)
    .join("\n  ");
}

/// Texture coordinates `meshOutput.vertex.uv` derives from a decoded vertex, in
/// texture repeats. The shader computes the same thing.
export function vertexUv(vertex) {
  const x = vertex.x / POSITION_UNITS_PER_BLOCK;
  const y = vertex.y / POSITION_UNITS_PER_BLOCK;
  const z = vertex.z / POSITION_UNITS_PER_BLOCK;
  switch (vertex.normal) {
    case NORMAL.down:
    case NORMAL.up:
      return [x, z];
    case NORMAL.north:
    case NORMAL.south:
      return [x, -y];
    case NORMAL.west:
    case NORMAL.east:
      return [z, -y];
    default:
      return [...CROSS_CORNER_UV[vertex.aoOrCorner]];
  }
}

/// Reads and checks the header at `ptr`; `len` is the buffer length the mesher
/// reported. `{ ok: true, header }` or `{ ok: false, error }`; a buffer that fails
/// any check must not be uploaded.
export function parseMeshHeader(view, ptr, len) {
  if (len < MESH_HEADER_BYTES || ptr + MESH_HEADER_BYTES > view.byteLength) {
    return { ok: false, error: `mesh_buffer_length:${len}` };
  }
  const u32 = (at) => view.getUint32(ptr + at, true);
  const formatVersion = u32(F.formatVersion);
  if (formatVersion !== MESH_FORMAT_VERSION) return { ok: false, error: `mesh_format_version_unknown:${formatVersion}` };
  const vertexStride = u32(F.vertexStride);
  if (vertexStride !== VERTEX_STRIDE) return { ok: false, error: `mesh_vertex_stride:${vertexStride}` };

  const segments = {
    opaque: { offset: u32(F.opaqueOffset), bytes: u32(F.opaqueBytes) },
    cutout: { offset: u32(F.cutoutOffset), bytes: u32(F.cutoutBytes) },
    translucent: { offset: u32(F.translucentOffset), bytes: u32(F.translucentBytes) },
  };
  let expected = MESH_HEADER_BYTES;
  for (const name of SEGMENTS) {
    const segment = segments[name];
    if (segment.offset !== expected) return { ok: false, error: `mesh_segment_offset:${name}:${segment.offset}` };
    if (segment.bytes % QUAD_BYTES !== 0) return { ok: false, error: `mesh_segment_not_whole_quads:${name}:${segment.bytes}` };
    expected += segment.bytes;
  }
  if (expected !== len) return { ok: false, error: `mesh_buffer_length:${len}:expected:${expected}` };
  if (ptr + len > view.byteLength) return { ok: false, error: `mesh_buffer_length:${len}:outside_memory` };

  return {
    ok: true,
    header: {
      formatVersion,
      vertexStride,
      sectionX: view.getInt32(ptr + F.sectionX, true),
      sectionY: u32(F.sectionY),
      sectionZ: view.getInt32(ptr + F.sectionZ, true),
      sectionRevision: view.getBigUint64(ptr + F.sectionRevision, true),
      meshSequence: view.getBigUint64(ptr + F.meshSequence, true),
      segments,
    },
  };
}
