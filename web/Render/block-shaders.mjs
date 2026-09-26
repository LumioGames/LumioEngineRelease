// Block shaders (GLSL ES 3.00). The vertex decode is generated from the bit table
// in mesh-layout.mjs, so the shader cannot drift from the contract layout.

import { glslVertexDecode } from "./mesh-format.mjs";
import { AO_UNOCCLUDED, CROSS_CORNER_UV, NORMAL, POSITION_UNITS_PER_BLOCK } from "./mesh-layout.mjs";

/// `uPass` values; the passes run in this order.
export const PASS_CODE = Object.freeze({ opaque: 0, cutout: 1, translucent: 2 });

const cornerUv = (axis) => CROSS_CORNER_UV.map((uv) => uv[axis].toFixed(1)).join(", ");

export const BLOCK_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in uvec2 aPacked;

uniform mat4 uViewProjection;
// Section origin minus camera position, in blocks.
uniform vec3 uSectionOrigin;

out vec2 vUv;
flat out float vLayer;
out vec3 vBlockLight;
out float vSky;
out float vShade;

const float CROSS_U[4] = float[4](${cornerUv(0)});
const float CROSS_V[4] = float[4](${cornerUv(1)});
// Fixed per-direction shading: down, up, north, south, west, east, cross.
const float FACE_SHADE[7] = float[7](0.5, 1.0, 0.8, 0.8, 0.6, 0.6, 0.9);

void main() {
  uint w0 = aPacked.x;
  uint w1 = aPacked.y;
  ${glslVertexDecode("w0", "w1")}

  vec3 local = vec3(float(x), float(y), float(z)) / ${POSITION_UNITS_PER_BLOCK.toFixed(1)};
  if (normal <= ${NORMAL.up}u) {
    vUv = vec2(local.x, local.z);
  } else if (normal <= ${NORMAL.south}u) {
    vUv = vec2(local.x, -local.y);
  } else if (normal <= ${NORMAL.east}u) {
    vUv = vec2(local.z, -local.y);
  } else {
    vUv = vec2(CROSS_U[aoOrCorner], CROSS_V[aoOrCorner]);
  }
  float ao = normal == ${NORMAL.cross}u ? ${AO_UNOCCLUDED.toFixed(1)} : float(aoOrCorner);
  vShade = FACE_SHADE[min(normal, ${NORMAL.cross}u)] * (0.4 + 0.2 * ao);
  vLayer = float(layer);
  vBlockLight = vec3(float(blockR), float(blockG), float(blockB));
  vSky = float(sky);
  gl_Position = uViewProjection * vec4(uSectionOrigin + local, 1.0);
}
`;

export const BLOCK_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform highp sampler2DArray uBlockTextures;
uniform int uPass;
uniform float uSkyBrightness;
uniform float uAmbient;
// Lighting debug view (setLighting): 0 normal, 1 block light only (RGB),
// 2 sky light only (grey), 3 light level heatmap of max(block R/G/B, sky x uSkyBrightness).
uniform int uDebugView;

in vec2 vUv;
flat in float vLayer;
in vec3 vBlockLight;
in float vSky;
in float vShade;

out vec4 outColor;

// Light level 0..15 to brightness, 0.8 per level below 15.
vec3 brightness(vec3 level) {
  return pow(vec3(0.8), vec3(15.0) - level);
}

void main() {
  vec4 texel = texture(uBlockTextures, vec3(vUv, vLayer));
  if (uPass == ${PASS_CODE.cutout} && texel.a < 0.5) discard;
  float alpha = uPass == ${PASS_CODE.translucent} ? texel.a : 1.0;
  vec3 block = brightness(vBlockLight);
  vec3 sky = brightness(vec3(vSky)) * uSkyBrightness;
  vec3 light = max(max(block, sky), vec3(uAmbient));
  if (uDebugView == 1) {
    outColor = vec4(brightness(vBlockLight) * (0.55 + 0.45 * vShade), alpha);
    return;
  }
  if (uDebugView == 2) {
    outColor = vec4(vec3(vSky / 15.0) * (0.55 + 0.45 * vShade), alpha);
    return;
  }
  if (uDebugView == 3) {
    float level = max(max(max(vBlockLight.r, vBlockLight.g), vBlockLight.b), vSky * uSkyBrightness) / 15.0;
    vec3 ramp = level < 0.5 ? mix(vec3(0.05, 0.05, 0.35), vec3(0.1, 0.8, 0.3), level * 2.0)
                            : mix(vec3(0.1, 0.8, 0.3), vec3(1.0, 0.25, 0.1), level * 2.0 - 1.0);
    if (level == 0.0) ramp = vec3(0.0);
    outColor = vec4(ramp * (0.55 + 0.45 * vShade), alpha);
    return;
  }
  outColor = vec4(texel.rgb * light * vShade, alpha);
}
`;
