import { operations } from './engine-wasm-bindings.mjs';

// Packet v1: argument count, buffer count, relocation count (u32 LE); arguments
// (kind, low/index, high), length-prefixed buffers, then relocations (source,
// source offset, target, target offset). All pointer relocation stays in Rust's
// memory. Handles/counters retain all 64 bits via bytes and BigInt.
// Kind 3 is a KernelHandle: the buffer is exactly the 32-byte five-field
// value (context u64, owner u64, slot u32, generation u32, registryId u64,
// little-endian). wasm32 lowers by-value KernelHandle parameters to a pointer
// to those exact bytes, so the bridge passes the wasm pointer of that buffer.
export function createEngineBridge(wasm) {
  const call = function call(operation, packet) {
    const signature = operations[operation];
    const fn = wasm[`lumio_engine_${operation}`];
    if (!signature || typeof fn !== 'function') throw new Error(`Engine WASM operation unavailable: ${operation}`);
    const bytes = new Uint8Array(packet);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let cursor = 0;
    const u32 = () => { const n = view.getUint32(cursor, true); cursor += 4; return n; };
    const argc = u32(), count = u32(), relocations = u32();
    if (argc !== signature.length || count > 65536 || relocations > 65536) throw new RangeError('Invalid Engine WASM packet');
    const args = Array.from({ length: argc }, () => [u32(), u32(), u32()]);
    const buffers = [], pointers = [];
    try {
      for (let i = 0; i < count; i++) {
        const length = u32();
        if (cursor + length > bytes.length) throw new RangeError('Truncated Engine WASM buffer');
        const data = bytes.slice(cursor, cursor + length); cursor += length;
        const pointer = wasm.lumio_engine_alloc(length);
        if (!pointer) throw new Error('Engine WASM allocation failed');
        pointers.push(pointer); buffers.push(data);
        new Uint8Array(wasm.memory.buffer, pointer, length).set(data);
      }
      for (let i = 0; i < relocations; i++) {
        const source = u32(), offset = u32(), target = u32(), targetOffset = u32();
        if (!buffers[source] || !buffers[target] || offset + 4 > buffers[source].length || targetOffset > buffers[target].length)
          throw new RangeError('Invalid Engine WASM relocation');
        new DataView(wasm.memory.buffer).setUint32(pointers[source] + offset, pointers[target] + targetOffset, true);
      }
      if (cursor !== bytes.length) throw new RangeError('Trailing Engine WASM packet bytes');
      const values = args.map(([kind, low, high], i) => {
        if (kind === 2 && signature[i] === 'pointer' && buffers[low]) return pointers[low];
        if (kind === 3 && signature[i] === 'handle' && buffers[low]?.length === 32) return pointers[low];
        if (kind === 1 && signature[i] === 'u64') return (BigInt(high) << 32n) | BigInt(low);
        if (kind === 0 && signature[i] !== 'u64' && signature[i] !== 'handle') return low;
        throw new RangeError('Engine WASM argument kind mismatch');
      });
      const status = fn(...values);
      const result = new Uint8Array(4 + buffers.reduce((n, b) => n + b.length, 0));
      new DataView(result.buffer).setInt32(0, status, true);
      let offset = 4;
      for (let i = 0; i < buffers.length; i++) {
        result.set(new Uint8Array(wasm.memory.buffer, pointers[i], buffers[i].length), offset);
        offset += buffers[i].length;
      }
      return result;
    } finally {
      for (let i = pointers.length - 1; i >= 0; i--) wasm.lumio_engine_free(pointers[i], buffers[i].length);
    }
  };
  call.createVoxelPresentation = handle => createVoxelPresentation(wasm, handle);
  return call;
}

// The renderer's existing ABI-shaped calls operate on this SDK module's actual
// memory and provider. Only the world argument representation is adapted here.
export function createVoxelPresentation(wasm, handle) {
  const validIdentity = value => (Array.isArray(value) || value instanceof Uint8Array) && value.length === 32
    && Array.from(value).every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  if (!validIdentity(handle)) throw new TypeError('A full Engine world handle is required');
  const identity = Uint8Array.from(handle);
  if (identity.length !== 32 || !identity.some(value => value !== 0)) throw new TypeError('A full Engine world handle is required');
  const world = Object.freeze([...identity]);
  const invoke = (operation, value, ...args) => {
    const source = validIdentity(value) ? value : new Uint8Array(32);
    const pointer = wasm.lumio_engine_alloc(32);
    if (!pointer) throw new Error('Engine WASM allocation failed');
    try {
      new Uint8Array(wasm.memory.buffer, pointer, 32).set(source);
      return wasm[`lumio_engine_presentation_${operation}`](pointer, ...args);
    } finally { wasm.lumio_engine_free(pointer, 32); }
  };
  return Object.freeze({ world, exports: Object.freeze({
    memory: wasm.memory,
    lumio_voxel_abi_version: () => 2,
    lumio_voxel_alloc: size => wasm.lumio_engine_alloc(size),
    lumio_voxel_free: (pointer, size) => wasm.lumio_engine_free(pointer, size),
    lumio_voxel_last_error_len: () => wasm.lumio_engine_presentation_last_error_len(),
    lumio_voxel_last_error: (pointer, size) => wasm.lumio_engine_presentation_last_error(pointer, size),
    lumio_voxel_mesher_create: (value, layers, count, out) => invoke('mesher_create', value, layers, count, out),
    lumio_voxel_mesher_destroy: mesher => invoke('mesher_destroy', world, mesher),
    lumio_voxel_mesh_section: (mesher, x, y, z, out) => invoke('mesh_section', world, mesher, x, y, z, out),
    lumio_voxel_mesh_release: (mesher, mesh) => invoke('mesh_release', world, mesher, mesh),
    lumio_voxel_remesh_pending_count: (value, out) => invoke('remesh_pending_count', value, out),
    lumio_voxel_drain_remesh: (value, keys, capacity, out) => invoke('drain_remesh', value, keys, capacity, out),
    lumio_voxel_light_read_cell: (value, x, y, z, out) => invoke('light_read_cell', value, x, y, z, out),
    lumio_voxel_light_section_digest: (value, x, y, z, out) => invoke('light_section_digest', value, x, y, z, out),
  }) });
}

export async function loadEngineWasm(base = new URL('.', import.meta.url)) {
  const info = await (await fetch(new URL('engine-wasm-build-info.json', base))).json();
  const binary = await (await fetch(new URL('lumio_engine_wasm_bg.wasm', base))).arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', binary))].map(x => x.toString(16).padStart(2, '0')).join('');
  if (digest !== info.binarySha256) throw new Error('Engine WASM binary identity mismatch');
  const { default: initialize } = await import(new URL('lumio_engine_wasm.js', base));
  return createEngineBridge(await initialize({ module_or_path: binary }));
}
