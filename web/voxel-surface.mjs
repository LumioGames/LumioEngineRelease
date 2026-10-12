export const SURFACE_LOADING = 0;
export const SURFACE_AIR = 1;
export const SURFACE_BLOCK = 2;

// The same presentation-only projection is used by both Native read adapters.
// readLayer returns detached values from the owner world, never decoded payloads.
export function readVoxelSurface(box, readLayer) {
  const width = box.maxX - box.minX + 1, depth = box.maxZ - box.minZ + 1;
  const cells = width * depth, blockIds = new Uint32Array(cells), states = new Uint8Array(cells);
  const unresolved = new Uint8Array(cells);
  let layersRead = 0, error = null, pending = cells;
  try {
    for (let y = box.maxY; y >= box.minY && pending > 0; y--) {
      const layer = readLayer(y, cells);
      if (layer.blockIds.length !== cells || layer.resolved.length !== cells) throw new Error('voxel_read_incomplete');
      layersRead++;
      for (let i = 0; i < cells; i++) {
        if (states[i] !== SURFACE_LOADING) continue;
        if (!layer.resolved[i]) { unresolved[i] = 1; continue; }
        const id = layer.blockIds[i];
        if ((id >>> 8) === 0) continue;
        states[i] = SURFACE_BLOCK; blockIds[i] = id; pending--;
      }
    }
  } catch (failure) {
    error = failure?.message ?? String(failure); unresolved.fill(1);
  }
  if (!layersRead) unresolved.fill(1);
  let block = 0, air = 0, loading = 0;
  for (let i = 0; i < cells; i++) {
    if (states[i] === SURFACE_BLOCK) block++;
    else if (unresolved[i]) loading++;
    else { states[i] = SURFACE_AIR; air++; }
  }
  return { width, depth, blockIds, states, counts: { block, air, loading }, layersRead, error };
}
