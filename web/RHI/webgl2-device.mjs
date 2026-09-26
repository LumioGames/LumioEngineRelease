// Thin WebGL2 device (ADR-124 D8).
//
// Wraps exactly four things: buffers, texture arrays, shader programs and draw
// calls, plus the depth / blend / cull switches a pass needs. No scene graph, no
// materials, no knowledge of voxels. A WebGPU backend would be a second file with
// the same surface; `Client/Render` would not change.

/// Error with a stable `code` so a page can show a message instead of a black canvas.
export class RenderDeviceError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "RenderDeviceError";
    this.code = code;
    this.detail = detail;
  }
}

const DEFAULT_CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: false,
  antialias: false,
  depth: true,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
});

/// Opens WebGL2 on `canvas`. Throws `RenderDeviceError` with code
/// `webgl2_unavailable` when the browser (or a blocklisted GPU) gives no WebGL2
/// context: the page must show that, never paint an empty canvas.
export function createWebGL2Device(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== "function") {
    throw new RenderDeviceError("canvas_missing", "The block renderer needs a <canvas> element to draw on.");
  }
  let gl = null;
  try {
    gl = canvas.getContext("webgl2", { ...DEFAULT_CONTEXT_ATTRIBUTES, ...(options.contextAttributes ?? {}) });
  } catch (error) {
    throw new RenderDeviceError(
      "webgl2_unavailable",
      `WebGL2 is not available (${error && error.message ? error.message : error}). The block renderer needs WebGL2.`,
    );
  }
  if (!gl) {
    throw new RenderDeviceError(
      "webgl2_unavailable",
      "WebGL2 is not available in this browser or on this GPU. The block renderer needs WebGL2; enable hardware acceleration or use a current desktop Chrome.",
    );
  }
  return wrapContext(gl);
}

function wrapContext(gl) {
  const limits = Object.freeze({
    maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  });

  // Last applied pipeline state; `null` fields are unknown and always re-applied.
  const applied = { depthTest: null, depthWrite: null, blend: null, cullBack: null };

  function targetOf(buffer) {
    return buffer.kind === "index" ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
  }

  function compile(stage, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? "";
      gl.deleteShader(shader);
      throw new RenderDeviceError("shader_compile_failed", `${stage} shader failed to compile:\n${log}`, { stage, log });
    }
    return shader;
  }

  return {
    backend: "webgl2",
    gl,
    limits,

    /// `kind` is "vertex" or "index".
    createBuffer(kind) {
      if (kind !== "vertex" && kind !== "index") throw new TypeError(`unknown buffer kind ${kind}`);
      return { kind, glBuffer: gl.createBuffer(), byteLength: 0 };
    },

    /// Submits `view` as the whole content of `buffer`. `view` is handed to
    /// `bufferData` as is: a view over wasm linear memory goes straight to the
    /// driver, with no JS-side copy in between.
    writeBuffer(buffer, view) {
      if (!ArrayBuffer.isView(view)) throw new TypeError("writeBuffer takes an ArrayBufferView");
      const target = targetOf(buffer);
      gl.bindBuffer(target, buffer.glBuffer);
      gl.bufferData(target, view, gl.STATIC_DRAW);
      buffer.byteLength = view.byteLength;
    },

    deleteBuffer(buffer) {
      if (buffer && buffer.glBuffer) gl.deleteBuffer(buffer.glBuffer);
      if (buffer) buffer.glBuffer = null;
    },

    /// A vertex array object over one vertex buffer. Each attribute:
    /// `{ location, components, type: "u32" | "f32", stride, offset }`; `u32`
    /// attributes stay integers in the shader (`vertexAttribIPointer`).
    createVertexLayout(buffer, attributes) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer.glBuffer);
      for (const attribute of attributes) {
        gl.enableVertexAttribArray(attribute.location);
        if (attribute.type === "u32") {
          gl.vertexAttribIPointer(attribute.location, attribute.components, gl.UNSIGNED_INT, attribute.stride, attribute.offset);
        } else if (attribute.type === "f32") {
          gl.vertexAttribPointer(attribute.location, attribute.components, gl.FLOAT, false, attribute.stride, attribute.offset);
        } else {
          throw new TypeError(`unknown attribute type ${attribute.type}`);
        }
      }
      gl.bindVertexArray(null);
      return { vao, buffer };
    },

    deleteVertexLayout(layout) {
      if (layout && layout.vao) gl.deleteVertexArray(layout.vao);
      if (layout) layout.vao = null;
    },

    /// `TEXTURE_2D_ARRAY`, RGBA8, one mip level, REPEAT + NEAREST (block-asset-v1
    /// texture.sampling).
    createTextureArray({ width, height, layers }) {
      if (layers < 1 || layers > limits.maxArrayTextureLayers) {
        throw new RenderDeviceError("texture_layers_out_of_range", `texture array needs ${layers} layers; device allows ${limits.maxArrayTextureLayers}`);
      }
      const glTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, glTexture);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, width, height, layers);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
      return { glTexture, width, height, layers };
    },

    /// Uploads one layer. `source` is RGBA8 bytes (`width * height * 4`) or any
    /// `TexImageSource` of the right size (an `ImageBitmap` from the PNG decoder).
    writeTextureLayer(texture, layer, source) {
      if (layer < 0 || layer >= texture.layers) throw new RangeError(`layer ${layer} outside 0..${texture.layers - 1}`);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture.glTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      if (ArrayBuffer.isView(source)) {
        const expected = texture.width * texture.height * 4;
        if (source.byteLength !== expected) {
          throw new RangeError(`layer ${layer} has ${source.byteLength} bytes; RGBA8 ${texture.width}x${texture.height} needs ${expected}`);
        }
      } else if (source.width !== texture.width || source.height !== texture.height) {
        throw new RangeError(`layer ${layer} image is ${source.width}x${source.height}; the array is ${texture.width}x${texture.height}`);
      }
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, texture.width, texture.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, source);
    },

    deleteTexture(texture) {
      if (texture && texture.glTexture) gl.deleteTexture(texture.glTexture);
      if (texture) texture.glTexture = null;
    },

    /// Compiles and links. A compile or link failure throws `RenderDeviceError`
    /// whose message carries the driver's info log verbatim.
    createProgram({ vertex, fragment }) {
      const vs = compile("vertex", gl.VERTEX_SHADER, vertex);
      let fs;
      try {
        fs = compile("fragment", gl.FRAGMENT_SHADER, fragment);
      } catch (error) {
        gl.deleteShader(vs);
        throw error;
      }
      const glProgram = gl.createProgram();
      gl.attachShader(glProgram, vs);
      gl.attachShader(glProgram, fs);
      gl.linkProgram(glProgram);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(glProgram) ?? "";
        gl.deleteProgram(glProgram);
        throw new RenderDeviceError("program_link_failed", `shader program failed to link:\n${log}`, { stage: "link", log });
      }
      return { glProgram, locations: new Map() };
    },

    deleteProgram(program) {
      if (program && program.glProgram) gl.deleteProgram(program.glProgram);
      if (program) program.glProgram = null;
    },

    useProgram(program) {
      gl.useProgram(program.glProgram);
    },

    /// `kind`: "mat4" | "vec3" | "vec4" | "float" | "int". The program must be in use.
    setUniform(program, name, kind, value) {
      let location = program.locations.get(name);
      if (location === undefined) {
        location = gl.getUniformLocation(program.glProgram, name);
        program.locations.set(name, location);
      }
      if (location === null) return;
      switch (kind) {
        case "mat4": gl.uniformMatrix4fv(location, false, value); break;
        case "vec3": gl.uniform3f(location, value[0], value[1], value[2]); break;
        case "vec4": gl.uniform4f(location, value[0], value[1], value[2], value[3]); break;
        case "float": gl.uniform1f(location, value); break;
        case "int": gl.uniform1i(location, value); break;
        default: throw new TypeError(`unknown uniform kind ${kind}`);
      }
    },

    bindTextureArray(unit, texture) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture.glTexture);
    },

    beginFrame({ width, height, clearColor = [0, 0, 0, 1] }) {
      gl.viewport(0, 0, width, height);
      gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
      // Depth writes must be on for the clear to reach the depth buffer.
      gl.depthMask(true);
      applied.depthWrite = true;
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    },

    /// `{ depthTest, depthWrite, blend, cullBack }`. Blending is straight alpha
    /// (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`).
    setPipelineState(state) {
      if (state.depthTest !== applied.depthTest) {
        if (state.depthTest) {
          gl.enable(gl.DEPTH_TEST);
          gl.depthFunc(gl.LEQUAL);
        } else {
          gl.disable(gl.DEPTH_TEST);
        }
        applied.depthTest = state.depthTest;
      }
      if (state.depthWrite !== applied.depthWrite) {
        gl.depthMask(state.depthWrite);
        applied.depthWrite = state.depthWrite;
      }
      if (state.blend !== applied.blend) {
        if (state.blend) {
          gl.enable(gl.BLEND);
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        } else {
          gl.disable(gl.BLEND);
        }
        applied.blend = state.blend;
      }
      if (state.cullBack !== applied.cullBack) {
        if (state.cullBack) {
          gl.enable(gl.CULL_FACE);
          gl.cullFace(gl.BACK);
          gl.frontFace(gl.CCW);
        } else {
          gl.disable(gl.CULL_FACE);
        }
        applied.cullBack = state.cullBack;
      }
    },

    /// `count` indices of `UNSIGNED_INT` triangles from `indexBuffer`, vertices from `layout`.
    drawIndexedTriangles({ layout, indexBuffer, count }) {
      gl.bindVertexArray(layout.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer.glBuffer);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    },
  };
}
