// Block asset descriptions and textures (engine/wire/block-asset-v1.json, ADR-124 D6 / D8).
//
// Assets downloads and checks; it assigns no layer numbers and touches no GPU.
// Render turns the result into a texture array and the face texture table.
//
// Failure never rejects the catalog, never skips a block and never substitutes
// another texture: whatever fails leaves its slots `null` (Render writes layer 0,
// the missing-texture checkerboard) and reports one warning.

import { FACE_SLOTS } from "../Render/mesh-layout.mjs";

export { FACE_SLOTS };
export const BLOCK_ASSET_FORMAT = "lumio.block-asset.v1";
export const PACK_FORMAT = "lumio.block-asset-pack.v1";

const CROSS_SLOT = FACE_SLOTS.indexOf("cross");

/// Where each slot looks, most specific key first (faceResolution.slotSource).
const SLOT_SOURCES = Object.freeze([
  ["bottom", "all"],
  ["top", "all"],
  ["north", "side", "all"],
  ["south", "side", "all"],
  ["west", "side", "all"],
  ["east", "side", "all"],
]);
const FACE_KEYS = new Set(["all", "side", "top", "bottom", "north", "south", "west", "east"]);
const DESCRIPTION_KEYS = new Set(["format", "faces", "cross", "license"]);

const ASSET_REF_PREFIX = "asset://blocks/";
const ASSET_ID_PATTERN = /^(?!.*\.\.)[a-z0-9_][a-z0-9_.-]*$/;
const TEXTURE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_./-]+\.png$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const DESCRIPTION_DIR = "Blocks/";
const PACK_PATH = "Blocks/pack.json";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isPowerOfTwo = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

/// `asset://blocks/<id>` → `{ ok: true, id }`, else `{ ok: false, reason }`.
export function parseAssetRef(assetRef) {
  if (typeof assetRef !== "string" || !assetRef.startsWith(ASSET_REF_PREFIX)) {
    return { ok: false, reason: "asset_ref_invalid:syntax" };
  }
  const id = assetRef.slice(ASSET_REF_PREFIX.length);
  if (!ASSET_ID_PATTERN.test(id)) return { ok: false, reason: "asset_ref_invalid:id" };
  return { ok: true, id };
}

export function isValidTexturePath(path) {
  return typeof path === "string" && TEXTURE_PATH_PATTERN.test(path);
}

/// One description → seven slots of texture paths (relative to the description) or
/// `null`. An invalid description resolves to seven `null`s.
export function resolveBlockDescription(description) {
  const invalid = (reason) => ({ invalid: true, reason, slots: Array(FACE_SLOTS.length).fill(null) });
  if (!isObject(description)) return invalid("description_invalid:not_an_object");
  for (const key of Object.keys(description)) {
    if (!DESCRIPTION_KEYS.has(key)) return invalid(`description_invalid:unknown_key:${key}`);
  }
  if (description.format !== BLOCK_ASSET_FORMAT) return invalid("description_invalid:format");
  const { faces } = description;
  if (!isObject(faces)) return invalid("description_invalid:faces");
  for (const [key, value] of Object.entries(faces)) {
    if (!FACE_KEYS.has(key)) return invalid(`description_invalid:unknown_face_key:${key}`);
    if (typeof value !== "string") return invalid(`description_invalid:face_value:${key}`);
  }
  if ("cross" in description && typeof description.cross !== "string") return invalid("description_invalid:cross");
  if ("license" in description && !isObject(description.license)) return invalid("description_invalid:license");

  const slots = SLOT_SOURCES.map((keys) => {
    for (const key of keys) if (key in faces) return faces[key];
    return null;
  });
  slots.push(description.cross ?? null);
  return { invalid: false, reason: null, slots };
}

/// `Blocks/pack.json` → `{ ok: true, textureSize }`, else `{ ok: false, reason }`.
export function parsePackManifest(manifest) {
  if (!isObject(manifest)) return { ok: false, reason: "pack_manifest_invalid:not_an_object" };
  if (manifest.format !== PACK_FORMAT) return { ok: false, reason: "pack_manifest_invalid:format" };
  const size = manifest.textureSize;
  if (!isPowerOfTwo(size) || size < 16 || size > 512) return { ok: false, reason: "pack_manifest_invalid:textureSize" };
  if ("license" in manifest && !isObject(manifest.license)) return { ok: false, reason: "pack_manifest_invalid:license" };
  return { ok: true, textureSize: size };
}

/// Which slots a block actually draws, from its template and the shape table:
/// box faces for everything except a shape made of crosses only, the cross slot
/// only when a sub-shape has crosses. Used to decide what "uncovered" means.
function drawnSlots(row, shapeTable) {
  const entry = isObject(shapeTable) ? shapeTable[row.name] : undefined;
  if (!Array.isArray(entry)) return { faces: true, cross: false };
  let faces = row.behaviorTemplate === "Connected";
  let cross = false;
  for (const subShape of entry) {
    if (Array.isArray(subShape?.boxes) && subShape.boxes.length > 0) faces = true;
    if (Array.isArray(subShape?.crosses) && subShape.crosses.length > 0) cross = true;
  }
  return { faces, cross };
}

function defaultWarn(warning) {
  // eslint-disable-next-line no-console
  console.warn(warning.message, warning);
}

async function defaultDecodeImage(buffer) {
  if (typeof createImageBitmap !== "function") throw new Error("image_decoder_unavailable");
  const bitmap = await createImageBitmap(new Blob([buffer], { type: "image/png" }), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  return { width: bitmap.width, height: bitmap.height, source: bitmap };
}

function isPng(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, PNG_SIGNATURE.length));
  return bytes.length === PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/// Downloads and checks everything the catalog's `assetRef`s point to.
///
/// - `catalog`: the catalog v2 envelope (object or JSON string) — the same bytes the
///   wasm world was created with. Rows are read by `blockType` ascending.
/// - `assetRoot`: URL of the game's asset root (the directory holding `Blocks/`).
/// - `onWarning(warning)`: `{ blockType, name, slot, slots, path, reason, message }`;
///   defaults to `console.warn`.
/// - `fetchImpl`, `decodeImage`: injectable for tests; `decodeImage(ArrayBuffer)`
///   resolves `{ width, height, source }` where `source` is RGBA8 bytes or a `TexImageSource`.
///
/// Resolves `{ textureSize, packValid, blocks: [{ blockType, name, slots }], images }`:
/// each slot is a texture key (path from the asset root) or `null`; `images` maps
/// every key that loaded and passed the checks to its decoded image.
export async function loadBlockAssets(options) {
  const {
    catalog,
    assetRoot,
    fetchImpl = typeof fetch === "function" ? fetch : null,
    decodeImage = defaultDecodeImage,
    onWarning = defaultWarn,
  } = options;
  if (typeof fetchImpl !== "function") throw new TypeError("loadBlockAssets needs fetch");
  const envelope = typeof catalog === "string" ? JSON.parse(catalog) : catalog;
  const rows = [...(envelope?.rows ?? [])].sort((a, b) => a.blockType - b.blockType);
  const root = String(assetRoot ?? "").endsWith("/") ? String(assetRoot) : `${assetRoot ?? ""}/`;

  const warnings = [];
  const warn = (rowInfo, slots, path, reason) => {
    const slot = slots === "*" ? "*" : slots.join(",");
    warnings.push({
      blockType: rowInfo?.blockType ?? null,
      name: rowInfo?.name ?? null,
      slot,
      slots: slots === "*" ? [...FACE_SLOTS] : slots,
      path,
      reason,
      message: rowInfo
        ? `block asset: ${rowInfo.name} (blockType ${rowInfo.blockType}) slot ${slot} path ${path ?? "-"}: ${reason}; drawing layer 0`
        : `block asset: ${reason}; every block draws layer 0`,
    });
  };
  const blocks = rows.map((r) => ({ blockType: r.blockType, name: r.name, slots: Array(FACE_SLOTS.length).fill(null) }));
  const images = new Map();
  const finish = (textureSize, packValid) => {
    for (const warning of warnings) onWarning(warning);
    return { textureSize, packValid, blocks, images };
  };

  const fetchOk = async (path) => {
    try {
      const response = await fetchImpl(root + path);
      if (!response || response.ok === false) return { ok: false, reason: `http_${response ? response.status : "no_response"}` };
      return { ok: true, response };
    } catch (error) {
      return { ok: false, reason: `fetch_failed:${error && error.message ? error.message : error}` };
    }
  };

  // 1. Pack manifest: without a valid one no texture can be trusted to fit the array.
  const packFetch = await fetchOk(PACK_PATH);
  let pack;
  if (!packFetch.ok) {
    pack = { ok: false, reason: `pack_manifest_missing:${packFetch.reason}` };
  } else {
    try {
      pack = parsePackManifest(JSON.parse(await packFetch.response.text()));
    } catch {
      pack = { ok: false, reason: "pack_manifest_invalid:json" };
    }
  }
  if (!pack.ok) {
    warn(null, "*", PACK_PATH, pack.reason);
    return finish(null, false);
  }
  const textureSize = pack.textureSize;

  // 2. Descriptions, one fetch per distinct id.
  const descriptionFetches = new Map();
  const loadDescription = (id) => {
    if (!descriptionFetches.has(id)) {
      descriptionFetches.set(id, (async () => {
        const path = `${DESCRIPTION_DIR}${id}.json`;
        const got = await fetchOk(path);
        if (!got.ok) return { path, error: `description_missing:${got.reason}` };
        let json;
        try {
          json = JSON.parse(await got.response.text());
        } catch {
          return { path, error: "description_invalid_json" };
        }
        return { path, resolved: resolveBlockDescription(json) };
      })());
    }
    return descriptionFetches.get(id);
  };

  const plans = await Promise.all(rows.map(async (r) => {
    const ref = parseAssetRef(r.assetRef);
    if (!ref.ok) return { error: ref.reason, path: typeof r.assetRef === "string" ? r.assetRef : null };
    return loadDescription(ref.id);
  }));

  // 3. Slot paths → texture keys, with uncovered / bad-path warnings.
  const wanted = new Set();
  const pending = rows.map((r, index) => {
    const plan = plans[index];
    if (plan.error) {
      warn(r, "*", plan.path, plan.error);
      return null;
    }
    if (plan.resolved.invalid) {
      warn(r, "*", plan.path, plan.resolved.reason);
      return null;
    }
    const drawn = drawnSlots(r, envelope.shapeTable);
    const uncovered = [];
    const badPaths = new Map();
    const keys = plan.resolved.slots.map((path, slot) => {
      if (path === null) {
        if (slot < CROSS_SLOT ? drawn.faces : drawn.cross) uncovered.push(FACE_SLOTS[slot]);
        return null;
      }
      if (!isValidTexturePath(path)) {
        if (!badPaths.has(path)) badPaths.set(path, []);
        badPaths.get(path).push(FACE_SLOTS[slot]);
        return null;
      }
      const key = DESCRIPTION_DIR + path;
      wanted.add(key);
      return key;
    });
    if (uncovered.length) warn(r, uncovered, null, "slot_uncovered");
    for (const [path, slots] of badPaths) warn(r, slots, path, "texture_path_invalid");
    return keys;
  });

  // 4. Textures, one fetch per distinct key, checked against the pack size.
  const failures = new Map();
  await Promise.all([...wanted].map(async (key) => {
    const got = await fetchOk(key);
    if (!got.ok) {
      failures.set(key, `texture_missing:${got.reason}`);
      return;
    }
    try {
      const buffer = await got.response.arrayBuffer();
      if (!isPng(buffer)) {
        failures.set(key, "texture_not_png");
        return;
      }
      const image = await decodeImage(buffer);
      if (image.width !== image.height) failures.set(key, `texture_not_square:${image.width}x${image.height}`);
      else if (!isPowerOfTwo(image.width)) failures.set(key, `texture_size_not_power_of_two:${image.width}`);
      else if (image.width !== textureSize) failures.set(key, `texture_size_mismatch:${image.width}:pack:${textureSize}`);
      else images.set(key, image);
    } catch (error) {
      failures.set(key, `texture_decode_failed:${error && error.message ? error.message : error}`);
    }
  }));

  // 5. Final slots; one warning per block and failed texture.
  rows.forEach((r, index) => {
    const keys = pending[index];
    if (!keys) return;
    const failedSlots = new Map();
    keys.forEach((key, slot) => {
      if (key === null) return;
      if (failures.has(key)) {
        if (!failedSlots.has(key)) failedSlots.set(key, []);
        failedSlots.get(key).push(FACE_SLOTS[slot]);
        return;
      }
      blocks[index].slots[slot] = key;
    });
    for (const [key, slots] of failedSlots) warn(r, slots, key, failures.get(key));
  });

  // Warnings leave in block order, not in network completion order.
  warnings.sort((a, b) => (a.blockType ?? -1) - (b.blockType ?? -1));
  return finish(textureSize, true);
}
