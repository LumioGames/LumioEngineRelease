// Section mesh buffers and the three-pass block draw (ADR-124 D8).
//
// Keeps, per Section key, one GPU vertex buffer per segment and the
// (sectionRevision, meshSequence) of the mesh on screen. Draws opaque, then
// cutout, then translucent far to near. Never builds or edits geometry and never
// touches authoritative state: it shows what the mesher produced.

import { BLOCK_FRAGMENT_SHADER, BLOCK_VERTEX_SHADER, PASS_CODE } from "./block-shaders.mjs";
import { QUAD_BYTES, QUAD_INDEX_PATTERN, QUAD_VERTICES, SECTION_BLOCKS, SEGMENTS, VERTEX_STRIDE } from "./mesh-layout.mjs";

const PASS_STATE = Object.freeze({
  opaque: Object.freeze({ depthTest: true, depthWrite: true, blend: false, cullBack: true }),
  // Alpha-tested in the shader (discard below 0.5); writes depth, no sorting.
  cutout: Object.freeze({ depthTest: true, depthWrite: true, blend: false, cullBack: true }),
  // Blended, reads depth, does not write it; Sections go far to near.
  translucent: Object.freeze({ depthTest: true, depthWrite: false, blend: true, cullBack: true }),
});

const INDICES_PER_QUAD = QUAD_INDEX_PATTERN.length;
const VERTEX_ATTRIBUTES = Object.freeze([{ location: 0, components: 2, type: "u32", stride: VERTEX_STRIDE, offset: 0 }]);

export const sectionKey = (x, y, z) => `${x}:${y}:${z}`;

/// `{ device, texture, clearColor?, skyBrightness?, ambient? }`; `texture` is the
/// block texture array (`createBlockTextureArray`).
export function createBlockRenderer({ device, texture, clearColor = [0.53, 0.72, 0.92, 1], skyBrightness = 1, ambient = 0.04 }) {
  const program = device.createProgram({ vertex: BLOCK_VERTEX_SHADER, fragment: BLOCK_FRAGMENT_SHADER });
  const sections = new Map();
  let blockTexture = texture;
  let indexBuffer = null;
  let indexQuads = 0;
  // Lighting debug view: 0 normal, 1 block light only, 2 sky light only, 3 light-level heatmap.
  let debugView = 0;

  function ensureIndexCapacity(quads) {
    if (quads <= indexQuads) return;
    let capacity = Math.max(256, indexQuads);
    while (capacity < quads) capacity *= 2;
    const indices = new Uint32Array(capacity * INDICES_PER_QUAD);
    for (let q = 0; q < capacity; q += 1) {
      for (let i = 0; i < INDICES_PER_QUAD; i += 1) indices[q * INDICES_PER_QUAD + i] = q * QUAD_VERTICES + QUAD_INDEX_PATTERN[i];
    }
    if (!indexBuffer) indexBuffer = device.createBuffer("index");
    device.writeBuffer(indexBuffer, indices);
    indexQuads = capacity;
  }

  function dropSegment(entry, name) {
    const segment = entry.segments[name];
    if (!segment) return;
    device.deleteVertexLayout(segment.layout);
    device.deleteBuffer(segment.buffer);
    entry.segments[name] = null;
  }

  function dropSection(key) {
    const entry = sections.get(key);
    if (!entry) return;
    for (const name of SEGMENTS) dropSegment(entry, name);
    sections.delete(key);
  }

  return {
    program,

    /// Revision rule (voxel-world-v1 meshOutput.releaseAndRevision): upload only if
    /// sectionRevision >= shown and meshSequence > shown. Anything else is dropped.
    ///
    /// `memory` is the ArrayBuffer the mesh lives in (wasm linear memory, re-taken by
    /// the caller right before this call) and `ptr` its header address. The segments
    /// go to the GPU as views over that memory, with no copy; the caller must not
    /// enter wasm between taking `memory` and this call returning.
    submitMesh(header, memory, ptr) {
      const key = sectionKey(header.sectionX, header.sectionY, header.sectionZ);
      const shown = sections.get(key);
      if (shown) {
        if (header.sectionRevision < shown.sectionRevision) return { uploaded: false, reason: "stale_section_revision" };
        if (header.meshSequence <= shown.meshSequence) return { uploaded: false, reason: "stale_mesh_sequence" };
      }
      const entry = shown ?? {
        sectionX: header.sectionX,
        sectionY: header.sectionY,
        sectionZ: header.sectionZ,
        segments: { opaque: null, cutout: null, translucent: null },
      };
      for (const name of SEGMENTS) {
        const { offset, bytes } = header.segments[name];
        if (bytes === 0) {
          dropSegment(entry, name);
          continue;
        }
        let segment = entry.segments[name];
        if (!segment) {
          const buffer = device.createBuffer("vertex");
          segment = { buffer, layout: device.createVertexLayout(buffer, VERTEX_ATTRIBUTES), quads: 0 };
          entry.segments[name] = segment;
        }
        device.writeBuffer(segment.buffer, new Uint8Array(memory, ptr + offset, bytes));
        segment.quads = bytes / QUAD_BYTES;
        ensureIndexCapacity(segment.quads);
      }
      entry.sectionRevision = header.sectionRevision;
      entry.meshSequence = header.meshSequence;
      sections.set(key, entry);
      return { uploaded: true, reason: null };
    },

    /// `{ sectionRevision, meshSequence }` on screen for `key`, or `null`.
    displayed(key) {
      const entry = sections.get(key);
      return entry ? { sectionRevision: entry.sectionRevision, meshSequence: entry.meshSequence } : null;
    },

    sectionKeys() {
      return [...sections.keys()];
    },

    /// The Section left this client: forget its mesh and its revision record.
    removeSection(x, y, z) {
      dropSection(sectionKey(x, y, z));
    },

    /// Forget everything (material pack swap: the mesher is rebuilt and every mesh regenerated).
    clear() {
      for (const key of [...sections.keys()]) dropSection(key);
    },

    setTexture(next) {
      blockTexture = next;
    },

    /// Runtime lighting controls (day/night and debug views): `{ skyBrightness?, ambient?, debugView?, clearColor? }`.
    setLighting(next) {
      if (next.skyBrightness !== undefined) skyBrightness = next.skyBrightness;
      if (next.ambient !== undefined) ambient = next.ambient;
      if (next.debugView !== undefined) debugView = next.debugView;
      if (next.clearColor !== undefined) clearColor = next.clearColor;
    },

    /// One frame: opaque → cutout → translucent (far to near).
    draw(camera, { width, height }) {
      device.beginFrame({ width, height, clearColor });
      device.useProgram(program);
      device.bindTextureArray(0, blockTexture);
      device.setUniform(program, "uBlockTextures", "int", 0);
      device.setUniform(program, "uViewProjection", "mat4", camera.viewProjection(width / Math.max(1, height)));
      device.setUniform(program, "uSkyBrightness", "float", skyBrightness);
      device.setUniform(program, "uAmbient", "float", ambient);
      device.setUniform(program, "uDebugView", "int", debugView);
      const [cx, cy, cz] = camera.position;
      const half = SECTION_BLOCKS / 2;

      for (const pass of SEGMENTS) {
        let list = [...sections.values()].filter((entry) => entry.segments[pass]);
        if (list.length === 0) continue;
        if (pass === "translucent") {
          const distance = (e) => (e.sectionX * SECTION_BLOCKS + half - cx) ** 2
            + (e.sectionY * SECTION_BLOCKS + half - cy) ** 2
            + (e.sectionZ * SECTION_BLOCKS + half - cz) ** 2;
          list = list
            .map((entry) => ({ entry, d: distance(entry) }))
            .sort((a, b) => b.d - a.d || a.entry.sectionX - b.entry.sectionX || a.entry.sectionY - b.entry.sectionY || a.entry.sectionZ - b.entry.sectionZ)
            .map(({ entry }) => entry);
        }
        device.setPipelineState(PASS_STATE[pass]);
        device.setUniform(program, "uPass", "int", PASS_CODE[pass]);
        for (const entry of list) {
          const segment = entry.segments[pass];
          device.setUniform(program, "uSectionOrigin", "vec3", [
            entry.sectionX * SECTION_BLOCKS - cx,
            entry.sectionY * SECTION_BLOCKS - cy,
            entry.sectionZ * SECTION_BLOCKS - cz,
          ]);
          device.drawIndexedTriangles({ layout: segment.layout, indexBuffer, count: segment.quads * INDICES_PER_QUAD });
        }
      }
    },

    destroy() {
      for (const key of [...sections.keys()]) dropSection(key);
      if (indexBuffer) device.deleteBuffer(indexBuffer);
      indexBuffer = null;
      indexQuads = 0;
      device.deleteProgram(program);
    },
  };
}
