// Texture layers and the face texture table (ADR-124 D6, block-asset-v1 layerAssignment).
//
// Layer 0 is always the missing-texture checkerboard generated here, never a file.
// Every slot that has no usable texture maps to it.

import { FACE_SLOTS, FIRST_CATALOG_BLOCK_TYPE, LAYER_MAX, LAYER_MISSING } from "./mesh-layout.mjs";

const FALLBACK_TEXTURE_SIZE = 16;

/// RGBA8 magenta / black checkerboard, 2 x 2 squares.
export function createMissingTexture(size = FALLBACK_TEXTURE_SIZE) {
  const pixels = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const magenta = (x < half) === (y < half);
      const at = (y * size + x) * 4;
      pixels[at] = magenta ? 255 : 0;
      pixels[at + 1] = 0;
      pixels[at + 2] = magenta ? 255 : 0;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

function defaultWarn(warning) {
  // eslint-disable-next-line no-console
  console.warn(warning.message, warning);
}

/// Assigns layers in the contract's fixed order: blockType ascending, the seven
/// slots of each row in table order, a texture key not seen before takes the next
/// layer from 1. Keys without a loaded image, and keys past `maxLayers`, get 0.
///
/// `blocks`: `[{ blockType, name, slots }]` from `loadBlockAssets`, dense from 256.
/// Returns `{ table: Uint16Array(rows * 7), layers }` where `layers[n]` is the key
/// on layer n (`layers[0]` is `null`, the checkerboard).
export function assignTextureLayers({ blocks, images, maxLayers, onWarning = defaultWarn }) {
  const rows = [...blocks].sort((a, b) => a.blockType - b.blockType);
  rows.forEach((block, i) => {
    if (block.blockType !== FIRST_CATALOG_BLOCK_TYPE + i) {
      throw new Error(`catalog_rows_not_dense: row ${i} is blockType ${block.blockType}, expected ${FIRST_CATALOG_BLOCK_TYPE + i}`);
    }
  });
  const limit = Math.min(maxLayers, LAYER_MAX + 1);
  const width = FACE_SLOTS.length;
  const table = new Uint16Array(rows.length * width);
  const layers = [null];
  const layerOf = new Map();

  rows.forEach((block, row) => {
    const overflow = new Map();
    block.slots.forEach((key, slot) => {
      let layer = LAYER_MISSING;
      if (key !== null && images.has(key)) {
        if (layerOf.has(key)) {
          layer = layerOf.get(key);
        } else if (layers.length < limit) {
          layer = layers.length;
          layers.push(key);
          layerOf.set(key, layer);
        } else {
          if (!overflow.has(key)) overflow.set(key, []);
          overflow.get(key).push(FACE_SLOTS[slot]);
        }
      }
      table[row * width + slot] = layer;
    });
    for (const [key, slots] of overflow) {
      const slot = slots.join(",");
      onWarning({
        blockType: block.blockType,
        name: block.name,
        slot,
        slots,
        path: key,
        reason: `texture_layer_limit:${limit}`,
        message: `block asset: ${block.name} (blockType ${block.blockType}) slot ${slot} path ${key}: texture_layer_limit:${limit}; drawing layer 0`,
      });
    }
  });
  return { table, layers };
}

/// Builds the `TEXTURE_2D_ARRAY`: the checkerboard on layer 0, then `images.get(layers[n])`
/// on layer n. `textureSize` is the pack's edge (16 when the pack was unusable).
export function createBlockTextureArray(device, { textureSize, layers, images }) {
  const size = textureSize ?? FALLBACK_TEXTURE_SIZE;
  const texture = device.createTextureArray({ width: size, height: size, layers: layers.length });
  device.writeTextureLayer(texture, LAYER_MISSING, createMissingTexture(size));
  for (let layer = 1; layer < layers.length; layer += 1) {
    device.writeTextureLayer(texture, layer, images.get(layers[layer]).source);
  }
  return texture;
}

/// Assets result → texture array plus face texture table, in one call.
export function buildBlockTextures(device, assets, onWarning) {
  const { table, layers } = assignTextureLayers({
    blocks: assets.blocks,
    images: assets.images,
    maxLayers: device.limits.maxArrayTextureLayers,
    onWarning,
  });
  const texture = createBlockTextureArray(device, { textureSize: assets.textureSize, layers, images: assets.images });
  return { texture, faceTable: table, layers };
}
