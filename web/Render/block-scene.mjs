// The few calls a game page makes to draw Sections on a <canvas> (ADR-124 D8).
//
//   const scene = await createBlockScene({ canvas, catalog, assetRoot, exports, world, onWarning });
//   // after each lumio_voxel_deliver_section, or once per animation frame:
//   scene.frame();
//
// Order inside: WebGL2 device → assets (descriptions + PNGs) → texture array and
// face texture table → wasm mesher with that table → renderer. The page owns the
// wasm instance, the world (created with the same catalog v2 JSON), the camera
// controls and the frame loop.

import { createWebGL2Device } from "../RHI/webgl2-device.mjs";
import { loadBlockAssets } from "../Assets/block-assets.mjs";
import { buildBlockTextures } from "./block-textures.mjs";
import { createBlockRenderer } from "./block-renderer.mjs";
import { createFreeCamera } from "./camera.mjs";
import { createMeshDriver } from "./voxel-mesher.mjs";

/// - `canvas`: the element to draw on. No WebGL2 → rejects with `RenderDeviceError`
///   code `webgl2_unavailable` before anything is downloaded.
/// - `catalog`: catalog v2 envelope (object or JSON string), the same one the world was created with.
/// - `assetRoot`: URL of the game's asset root (holds `Blocks/pack.json`, `Blocks/<id>.json`, textures).
/// - `exports`, `world`: lumio-voxel-wasm exports (ABI 2) and the world handle.
/// - `onWarning(warning)`: every asset / mesh warning; defaults to `console.warn`.
/// - `camera`: `createFreeCamera` options. `clearColor`, `fetchImpl`, `decodeImage`: optional.
/// - `worldRevisionOf(key)`, `revisionLagBudget`: optional; passed to the mesh driver for the
///   "mesh on screen trails the world" warning (`createMeshDriver`).
/// - `signal`: cancels pending asset loading before a mesher can acquire the world.
/// - `isWorldAlive()`: optional authoritative owner query; false means the Engine
///   has retired this world and its derived meshers, not just hidden the view.
export async function createBlockScene(options) {
  const {
    canvas, catalog, assetRoot, exports, world, onWarning, fetchImpl, decodeImage, camera: cameraOptions, clearColor,
    worldRevisionOf, revisionLagBudget, signal, isWorldAlive,
  } = options;
  signal?.throwIfAborted();
  const device = createWebGL2Device(canvas);
  const assets = await loadBlockAssets({ catalog, assetRoot, fetchImpl, decodeImage, onWarning });
  let texture, faceTable, layers, renderer, driver;
  const closeImages = () => { for (const image of assets.images.values()) image.source?.close?.(); };
  try {
    signal?.throwIfAborted();
    if (isWorldAlive && !isWorldAlive()) throw new DOMException("world_retired", "AbortError");
    ({ texture, faceTable, layers } = buildBlockTextures(device, assets, onWarning));
    renderer = createBlockRenderer({ device, texture, clearColor });
    driver = createMeshDriver({ exports, world, faceTable, renderer, onWarning, worldRevisionOf, revisionLagBudget, isWorldAlive });
  } catch (error) {
    renderer?.destroy();
    if (texture) device.deleteTexture(texture);
    throw error;
  } finally {
    // Texture upload is synchronous; decoded ImageBitmaps have no further owner.
    closeImages();
  }
  const camera = createFreeCamera(cameraOptions);
  let alive = true;

  return {
    device,
    assets,
    faceTable,
    layers,
    renderer,
    driver,
    camera,

    /// Meshes whatever the wasm side marked, then draws one frame.
    frame() {
      const stats = driver.pump();
      renderer.draw(camera, { width: canvas.width, height: canvas.height });
      return stats;
    },

    destroy() {
      if (!alive) return;
      alive = false;
      driver.destroy();
      renderer.destroy();
      device.deleteTexture(texture);
    },
  };
}
