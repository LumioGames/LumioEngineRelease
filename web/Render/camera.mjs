// Free-flying camera. y is up, yaw 0 looks north (-z), positive yaw turns east (+x).
//
// `viewProjection` has no translation: the renderer sends every Section origin
// already relative to `position` (computed in doubles), so far-from-origin worlds
// keep full float precision on the GPU.

const PITCH_LIMIT = Math.PI / 2 - 1e-3;

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export function createFreeCamera({
  position = [0, 0, 0],
  yaw = 0,
  pitch = 0,
  fovY = (70 * Math.PI) / 180,
  near = 0.05,
  far = 1024,
} = {}) {
  const camera = {
    position: [...position],
    yaw,
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch)),
    fovY,
    near,
    far,

    forward() {
      const cp = Math.cos(camera.pitch);
      return [Math.sin(camera.yaw) * cp, Math.sin(camera.pitch), -Math.cos(camera.yaw) * cp];
    },

    right() {
      return [Math.cos(camera.yaw), 0, Math.sin(camera.yaw)];
    },

    /// Moves along the view direction, the horizontal right axis and world up.
    move({ forward = 0, right = 0, up = 0 }) {
      const f = camera.forward();
      const r = camera.right();
      camera.position[0] += f[0] * forward + r[0] * right;
      camera.position[1] += f[1] * forward + up;
      camera.position[2] += f[2] * forward + r[2] * right;
    },

    turn(deltaYaw, deltaPitch) {
      camera.yaw += deltaYaw;
      camera.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camera.pitch + deltaPitch));
    },

    lookAt(target) {
      const dx = target[0] - camera.position[0];
      const dy = target[1] - camera.position[1];
      const dz = target[2] - camera.position[2];
      camera.yaw = Math.atan2(dx, -dz);
      camera.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.atan2(dy, Math.hypot(dx, dz))));
    },

    /// Column-major projection x rotation, for camera-relative positions.
    viewProjection(aspect) {
      const f = camera.forward();
      // s = normalize(f x up), u = s x f
      let s = [-f[2], 0, f[0]];
      const length = Math.hypot(s[0], s[2]) || 1;
      s = [s[0] / length, 0, s[2] / length];
      const u = [s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0]];
      const view = new Float32Array([
        s[0], u[0], -f[0], 0,
        s[1], u[1], -f[1], 0,
        s[2], u[2], -f[2], 0,
        0, 0, 0, 1,
      ]);
      const t = 1 / Math.tan(camera.fovY / 2);
      const projection = new Float32Array([
        t / aspect, 0, 0, 0,
        0, t, 0, 0,
        0, 0, (camera.far + camera.near) / (camera.near - camera.far), -1,
        0, 0, (2 * camera.far * camera.near) / (camera.near - camera.far), 0,
      ]);
      return multiply(projection, view);
    },
  };
  return camera;
}
