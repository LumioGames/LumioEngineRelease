import { readVoxelSurface } from './voxel-surface.mjs';

// A display adapter over the existing ClientSession world. It cannot deliver,
// release, create or destroy residency; every observation comes from ReadBox.
export function createReplicaVoxelGrid({ presentation, readBox }) {
  if (!presentation || typeof readBox !== 'function') throw new TypeError('A formal world renderer and box reader are required');
  let alive = true;
  const observed = new Map();
  return {
    status: 'ready', error: null, abiVersion: 2, worldRevision: null,
    get wasm() { return alive ? presentation : null; },
    sectionRevision(key) { return observed.get(key.startsWith('s:') ? key : `s:${key}`) ?? null; },
    sections() { return [...observed].map(([key, revision]) => ({ key, revision })); },
    readSurface(box) {
      observed.clear();
      let snapshot;
      return readVoxelSurface(box, (y, columns) => {
        if (!alive) throw new Error('world_destroyed');
        if (!snapshot) {
          snapshot = readBox(box);
          if (typeof snapshot === 'string') snapshot = JSON.parse(snapshot);
          if (!Array.isArray(snapshot?.cells) || snapshot.cells.length !== columns * (box.maxY - box.minY + 1)
            || !Array.isArray(snapshot.sections)) throw new Error('voxel_read_incomplete');
          const next = new Map();
          for (const section of snapshot.sections) {
            if (section.presence !== 'Ready' && section.presence !== 'Unchanged') continue;
            if (typeof section.revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(section.revision)) throw new Error('voxel_revision_invalid');
            next.set(`s:${section.x}:${section.y}:${section.z}`, section.revision);
          }
          for (const [key, revision] of next) observed.set(key, revision);
        }
        const cells = snapshot.cells.slice((y - box.minY) * columns, (y - box.minY + 1) * columns);
        return {
          blockIds: Uint32Array.from(cells, cell => cell.blockId ?? 0),
          resolved: Uint8Array.from(cells, cell => cell.hasBlockId && (cell.presence === 'Ready' || cell.presence === 'Unchanged') ? 1 : 0),
        };
      });
    },
    destroy() { alive = false; observed.clear(); },
  };
}
