(function () {
  const RECIPE = __RECIPE__;

  const t0 = performance.now();
  const out = {
    meta: { collector: RECIPE.version, collectedAt: new Date().toISOString(), recipe: RECIPE.recipeId },
    collected: { canvas: {}, imageData: {}, glPixels: {}, audio: {}, text: {} },
    calibration: {},
    probes: {},
    absent: {},
  };
  const warn = [];

  function b64(bytes) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(s);
  }

  function tryGet(fn, fallback) {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      warn.push(String(e && e.message));
      return fallback;
    }
  }

  function serialize(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
    if (ArrayBuffer.isView(v)) return [Object.prototype.toString.call(v).slice(8, -1)].concat(Array.prototype.slice.call(v));
    if (Array.isArray(v)) return v.map(serialize);
    if (typeof WebGLTexture !== "undefined" && v instanceof Object) return String(v);
    return String(v);
  }

  function resolvePath(path) {
    const parts = path.split(".");
    let cur = window;
    for (let i = 1; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = parts[i] === "__proto__" ? Object.getPrototypeOf(cur) : cur[parts[i]];
    }
    return cur;
  }

  function newCanvas(w, h) {
    const c = document.createElement("canvas");
    if (w !== undefined) c.width = w;
    if (h !== undefined) c.height = h;
    return c;
  }

  const state = { lastImageData: null, gl: null, glCanvas: null };

  function decodeArg(a) {
    if (typeof a !== "string") return a;
    const m = a.match(/^(Float32Array|Float64Array|Int8Array|Int16Array|Int32Array|Uint8Array|Uint8ClampedArray|Uint16Array|Uint32Array)\[(.*)\]$/);
    if (m) return new window[m[1]](m[2] === "" ? [] : m[2].split(",").map(Number));
    if (a === "obj:ImageData") return state.lastImageData;
    return a;
  }

  function apply2d(spec, probeKey) {
    const canvas = newCanvas();
    const ctx = canvas.getContext("2d");
    const results = [];
    for (const op of spec.ops) {
      const name = op[0];
      if (name === "size") {
        canvas[op[1]] = op[2];
        continue;
      }
      if (name === "set") {
        ctx[op[1]] = op[2];
        continue;
      }
      if (name === "measureText") continue;
      const args = op.slice(1).map(decodeArg);
      if (name === "isPointInPath" || name === "isPointInStroke") {
        results.push([name].concat(op.slice(1), [ctx[name].apply(ctx, args)]));
        continue;
      }
      ctx[name].apply(ctx, args);
    }
    if (results.length && probeKey) out.probes[probeKey] = results;
    return { canvas, ctx };
  }

  function glPipeline(spec) {
    const ops = spec.ops;
    function find(n) {
      return ops.filter((o) => o[0] === n);
    }
    const canvas = newCanvas();
    for (const op of ops) if (op[0] === "size") canvas[op[1]] = op[2];
    const attrs = RECIPE.gl.contextAttributesRequested || undefined;
    const gl = canvas.getContext(RECIPE.gl.contextType, attrs);
    if (!gl) throw new Error("no " + RECIPE.gl.contextType + " context");
    const sources = find("gl.shaderSource").map((o) => o[2]);
    const vsSrc = sources.find((s) => /attribute|gl_Position/.test(s));
    const fsSrc = sources.find((s) => /gl_FragColor|precision/.test(s) && s !== vsSrc);
    const vertices = decodeArg((find("gl.bufferData")[0] || [])[2]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    if (vertices) gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);
    out.probes["gl.compile"] = {
      vs: gl.getShaderParameter(vs, gl.COMPILE_STATUS),
      fs: gl.getShaderParameter(fs, gl.COMPILE_STATUS),
      link: gl.getProgramParameter(prog, gl.LINK_STATUS),
      vsLog: gl.getShaderInfoLog(vs),
      fsLog: gl.getShaderInfoLog(fs),
      progLog: gl.getProgramInfoLog(prog),
    };
    const attrName = (vsSrc.match(/attribute\s+\w+\s+(\w+)/) || [])[1];
    const uniName = (vsSrc.match(/uniform\s+\w+\s+(\w+)/) || [])[1];
    const loc = attrName ? gl.getAttribLocation(prog, attrName) : 0;
    gl.enableVertexAttribArray(loc);
    const vap = find("gl.vertexAttribPointer")[0];
    if (vap) gl.vertexAttribPointer(loc, vap[2], vap[3], vap[4], vap[5], vap[6]);
    const u2f = find("gl.uniform2f")[0];
    if (u2f && uniName) gl.uniform2f(gl.getUniformLocation(prog, uniName), u2f[2], u2f[3]);
    const draw = find("gl.drawArrays")[0];
    if (draw) gl.drawArrays(draw[1], draw[2], draw[3]);
    state.gl = gl;
    state.glCanvas = canvas;
    return { canvas, gl };
  }

  function runCanvasStep(entry, key) {
    const spec = entry.spec;
    const isGl = spec.ops.some((o) => String(o[0]).indexOf("gl.") === 0);
    const r = isGl ? glPipeline(spec) : apply2d(spec, key);
    out.collected.canvas[key] = spec.quality === null || spec.quality === undefined ? r.canvas.toDataURL(spec.type) : r.canvas.toDataURL(spec.type, spec.quality);
  }

  function runImageDataStep(entry, key) {
    const spec = entry.spec;
    const r = apply2d(spec, key);
    const img = r.ctx.getImageData(spec.x, spec.y, spec.w, spec.h);
    state.lastImageData = img;
    out.collected.imageData[key] = b64(new Uint8Array(img.data.buffer));
  }

  function runGlPixelsStep(entry, key) {
    const spec = entry.spec;
    const gl = state.gl;
    const buf = new Uint8Array(spec.len);
    gl.readPixels(spec.x, spec.y, spec.w, spec.h, spec.format, spec.type, buf);
    out.collected.glPixels[key] = b64(buf);
    const img = new ImageData(new Uint8ClampedArray(buf), spec.w, spec.h);
    state.lastImageData = img;
  }

  function runTextStep(entry, key) {
    const spec = entry.spec;
    const ctx = state.textCtx || (state.textCtx = newCanvas(10, 10).getContext("2d"));
    ctx.font = spec.font;
    const m = ctx.measureText(spec.text);
    out.collected.text[key] = [
      m.width,
      m.actualBoundingBoxLeft,
      m.actualBoundingBoxRight,
      m.actualBoundingBoxAscent,
      m.actualBoundingBoxDescent,
      m.fontBoundingBoxAscent,
      m.fontBoundingBoxDescent,
      m.emHeightAscent,
      m.emHeightDescent,
      m.hangingBaseline,
      m.alphabeticBaseline,
      m.ideographicBaseline,
    ];
  }

  async function runAudioStep(entry, key) {
    const spec = entry.spec;
    const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctor(spec.channels || 1, spec.length, spec.sampleRate);
    const made = {};
    for (const n of spec.nodes) {
      let node = null;
      if (n.kind === "OscillatorNode") {
        node = ctx.createOscillator();
        if (n.type !== undefined) node.type = n.type;
        if (n.frequency !== undefined) node.frequency.value = n.frequency;
        if (n.detune !== undefined) node.detune.value = n.detune;
      } else if (n.kind === "DynamicsCompressorNode") {
        node = ctx.createDynamicsCompressor();
        ["threshold", "knee", "ratio", "attack", "release"].forEach(function (p) {
          if (n[p] !== undefined) node[p].setValueAtTime(n[p], ctx.currentTime);
        });
      } else if (n.kind === "GainNode") {
        node = ctx.createGain();
        if (n.gain !== undefined) node.gain.value = n.gain;
      } else if (n.kind === "BiquadFilterNode") {
        node = ctx.createBiquadFilter();
        if (n.type !== undefined) node.type = n.type;
        ["frequency", "Q", "gain", "detune"].forEach(function (p) {
          if (n[p] !== undefined) node[p].value = n[p];
        });
      } else if (n.kind === "AnalyserNode") {
        node = ctx.createAnalyser();
        if (n.fftSize !== undefined) node.fftSize = n.fftSize;
      } else if (n.kind === "AudioDestinationNode") {
        node = ctx.destination;
      }
      made[n.label] = node;
    }
    for (const e of spec.edges) if (made[e[0]] && made[e[1]]) made[e[0]].connect(made[e[1]]);
    for (const n of spec.nodes) if (n.kind === "OscillatorNode" && made[n.label].start) made[n.label].start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(spec.channel || 0);
    out.collected.audio[key] = Array.prototype.slice.call(data);
  }

  function collectBlendTable() {
    const alphas = RECIPE.blendAlphas;
    const dim = RECIPE.blendCanvas;
    const table = {};
    const alphaOut = {};
    for (const a of alphas) {
      const c = newCanvas(dim.w, dim.h);
      const ctx = c.getContext("2d");
      for (let v = 0; v < 256; v++) {
        ctx.globalAlpha = a;
        ctx.fillStyle = "rgb(" + v + "," + v + "," + v + ")";
        ctx.fillRect(v % dim.w, Math.floor(v / dim.w), 1, 1);
      }
      const d = ctx.getImageData(0, 0, Math.min(256, dim.w), Math.ceil(256 / dim.w)).data;
      const row = new Uint8Array(256);
      for (let v = 0; v < 256; v++) row[v] = d[v * 4];
      table[String(a)] = b64(row);
      alphaOut[String(a)] = d[3];
    }
    out.calibration.blend = table;
    out.calibration.blendAlpha = alphaOut;
    out.calibration.blendCanvas = dim;

    const premul = {};
    for (const a of alphas) {
      const c = newCanvas(dim.w, dim.h);
      const ctx = c.getContext("2d");
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, Math.min(256, dim.w), Math.ceil(256 / dim.w) + 1);
      for (let v = 0; v < 256; v++) {
        ctx.globalAlpha = a;
        ctx.fillStyle = "rgb(" + v + "," + v + "," + v + ")";
        ctx.fillRect(v % dim.w, Math.floor(v / dim.w), 1, 1);
      }
      const d = ctx.getImageData(0, 0, Math.min(256, dim.w), Math.ceil(256 / dim.w)).data;
      const row = new Uint8Array(256);
      for (let v = 0; v < 256; v++) row[v] = d[v * 4];
      premul[String(a)] = b64(row);
    }
    out.calibration.premul = premul;
  }

  function collectBlendSamples() {
    const dim = RECIPE.blendCanvas;
    const samples = [];
    for (let n = 0; n < 48; n++) {
      const c = newCanvas(dim.w, dim.h);
      const ctx = c.getContext("2d");
      const ops = [];
      const layers = 1 + ((Math.random() * 3) | 0);
      for (let i = 0; i < layers; i++) {
        const alpha = Math.round(Math.random() * 10) / 10;
        const col = "#" + ("000000" + ((Math.random() * 0xffffff) | 0).toString(16)).slice(-6);
        const x = (Math.random() * 4) | 0;
        const y = (Math.random() * 4) | 0;
        const w = 1 + ((Math.random() * 2) | 0);
        const h = 1 + ((Math.random() * 2) | 0);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = col;
        ctx.fillRect(x, y, w, h);
        ops.push(["set", "globalAlpha", alpha]);
        ops.push(["set", "fillStyle", col]);
        ops.push(["fillRect", x, y, w, h]);
      }
      samples.push({ ops: ops, readback: b64(new Uint8Array(ctx.getImageData(0, 0, 5, 5).data.buffer)) });
    }
    out.calibration.blendSamples = samples;
  }

  function collectEncoderSamples() {
    const samples = [];
    const kinds = ["dense-opaque", "dense", "sparse", "sparse", "sparse-opaque", "zero", "one"];
    for (const dim of RECIPE.encoderSamples) {
      for (const kind of kinds) {
        const c = newCanvas(dim.w, dim.h);
        const ctx = c.getContext("2d");
        const img = ctx.createImageData(dim.w, dim.h);
        const px = img.data;
        if (kind.indexOf("dense") === 0) {
          for (let i = 0; i < px.length; i++) px[i] = (Math.random() * 256) | 0;
        } else if (kind.indexOf("sparse") === 0) {
          const n = Math.max(1, Math.round(dim.w * dim.h * 0.2));
          for (let k = 0; k < n; k++) {
            const i = ((Math.random() * dim.w * dim.h) | 0) * 4;
            px[i] = (Math.random() * 256) | 0;
            px[i + 1] = (Math.random() * 256) | 0;
            px[i + 2] = (Math.random() * 256) | 0;
            px[i + 3] = 179;
          }
        } else if (kind === "one") {
          px[0] = 255;
          px[3] = 255;
        }
        if (kind.indexOf("opaque") > 0) for (let i = 3; i < px.length; i += 4) px[i] = 255;
        ctx.putImageData(img, 0, 0);
        samples.push({
          w: dim.w,
          h: dim.h,
          type: dim.type,
          kind: kind,
          pixels: b64(new Uint8Array(px.buffer)),
          dataUrl: c.toDataURL(dim.type),
          readback: b64(new Uint8Array(ctx.getImageData(0, 0, dim.w, dim.h).data.buffer)),
        });
      }
    }
    out.calibration.encoderSamples = samples;
  }

  function collectGl() {
    const res = {};
    for (const version of RECIPE.gl.versions) {
      const gl = newCanvas(300, 150).getContext(version);
      if (!gl) {
        res[version] = null;
        continue;
      }
      const exts = {};
      const supported = gl.getSupportedExtensions() || [];
      for (const name of supported) {
        const e = tryGet(() => gl.getExtension(name), null);
        if (!e) {
          exts[name] = null;
          continue;
        }
        const detail = { tag: Object.prototype.toString.call(e).slice(8, -1), props: {} };
        const names = Object.getOwnPropertyNames(e);
        const protoNames = tryGet(() => Object.getOwnPropertyNames(Object.getPrototypeOf(e) || {}), []) || [];
        for (const key of names.concat(protoNames)) {
          if (key === "constructor") continue;
          const v = tryGet(() => e[key], undefined);
          if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") detail.props[key] = v;
          else if (typeof v === "function") detail.props[key] = { fn: v.name || key, length: v.length };
        }
        detail.own = names;
        detail.protoOwn = protoNames;
        exts[name] = detail;
      }
      const params = {};
      for (const p of RECIPE.gl.params) params[p] = serialize(tryGet(() => gl.getParameter(Number(p)), null));
      const precision = {};
      for (const key of RECIPE.gl.precision) {
        const parts = key.split(":").map(Number);
        const f = tryGet(() => gl.getShaderPrecisionFormat(parts[0], parts[1]), null);
        precision[key] = f ? [f.rangeMin, f.rangeMax, f.precision] : null;
      }
      res[version] = {
        params: params,
        precision: precision,
        supportedExtensions: gl.getSupportedExtensions(),
        extensionObjects: exts,
        contextAttributes: tryGet(() => Object.assign({}, gl.getContextAttributes()), null),
        unmaskedVendor: serialize(tryGet(() => gl.getParameter(37445), null)),
        unmaskedRenderer: serialize(tryGet(() => gl.getParameter(37446), null)),
        maxAnisotropy: serialize(tryGet(() => gl.getParameter(34047), null)),
      };
    }
    out.webglByVersion = res;
    const main = res[RECIPE.gl.contextType] || res[RECIPE.gl.versions[0]];
    if (main)
      out.webgl = {
        params: main.params,
        shaderPrecision: main.precision,
        extensions: main.supportedExtensions,
        contextAttributes: main.contextAttributes,
        unmaskedVendor: main.unmaskedVendor,
        unmaskedRenderer: main.unmaskedRenderer,
      };
  }

  async function collectPermissions() {
    const res = {};
    for (const name of RECIPE.permissions) {
      try {
        const s = await navigator.permissions.query({ name: name });
        res[name] = s.state;
      } catch (e) {
        res[name] = "unsupported";
      }
    }
    out.permissions = res;
  }

  function collectCodecs() {
    const v = document.createElement("video");
    const a = document.createElement("audio");
    const res = {};
    for (const type of RECIPE.codecs) res[type] = { video: tryGet(() => v.canPlayType(type), null), audio: tryGet(() => a.canPlayType(type), null) };
    out.codecs = res;
  }

  function describeKeys(target, instance) {
    const shape = [];
    for (const name of Object.getOwnPropertyNames(target)) {
      const d = tryGet(() => Object.getOwnPropertyDescriptor(target, name), null);
      if (!d) {
        shape.push([name, "undefined", "", 0, ""]);
        continue;
      }
      let flags = "";
      if (d.writable) flags += "w";
      if (d.enumerable) flags += "e";
      if (d.configurable) flags += "c";
      if (d.get || d.set) {
        let tag = "";
        let kind = "";
        if (instance) {
          try {
            const got = instance[name];
            kind = got === null ? "null" : typeof got;
            if (kind === "object") tag = Object.prototype.toString.call(got).slice(8, -1);
            else if (kind === "function") tag = got.name || "";
            else if (kind !== "undefined") tag = String(got).slice(0, 40);
          } catch (e) {
            kind = "throws";
          }
        }
        shape.push([name, "accessor", flags + (d.get ? "g" : "") + (d.set ? "s" : ""), 0, kind + ":" + tag]);
        continue;
      }
      const v = d.value;
      const t = typeof v;
      let len = 0;
      let tag = "";
      if (t === "function") {
        len = tryGet(() => v.length, 0);
        tag = tryGet(() => v.name, "") || "";
      } else if (t === "object" && v !== null) {
        tag = tryGet(() => Object.prototype.toString.call(v).slice(8, -1), "") || "";
      } else if (t === "string" || t === "number" || t === "boolean") {
        tag = String(v).slice(0, 40);
      }
      shape.push([name, v === null ? "null" : t, flags, len, tag]);
    }
    return shape;
  }

  function collectProtoShapes() {
    const targets = {
      "Window.prototype": () => Object.getPrototypeOf(window),
      "WindowProperties": () => Object.getPrototypeOf(Object.getPrototypeOf(window)),
      "EventTarget.prototype": () => EventTarget.prototype,
      "HTMLDocument.prototype": () => Object.getPrototypeOf(document),
      "Document.prototype": () => Object.getPrototypeOf(Object.getPrototypeOf(document)),
      "Node.prototype": () => Node.prototype,
      "Navigator.prototype": () => Navigator.prototype,
      "Screen.prototype": () => Screen.prototype,
      "Location.prototype": () => Object.getPrototypeOf(location),
      "Performance.prototype": () => Performance.prototype,
      "History.prototype": () => History.prototype,
      "Storage.prototype": () => Storage.prototype,
      "Element.prototype": () => Element.prototype,
      "HTMLElement.prototype": () => HTMLElement.prototype,
      "HTMLCanvasElement.prototype": () => HTMLCanvasElement.prototype,
      "CanvasRenderingContext2D.prototype": () => CanvasRenderingContext2D.prototype,
      "TextMetrics.prototype": () => TextMetrics.prototype,
      "Crypto.prototype": () => Crypto.prototype,
      "SubtleCrypto.prototype": () => SubtleCrypto.prototype,
    };
    const res = {};
    for (const name of Object.keys(targets)) {
      const obj = tryGet(targets[name], null);
      if (!obj) {
        res[name] = null;
        continue;
      }
      const instance = name === "Window.prototype" ? window : name === "HTMLDocument.prototype" || name === "Document.prototype" ? document : name === "Navigator.prototype" ? navigator : name === "Screen.prototype" ? screen : name === "Location.prototype" ? location : name === "Performance.prototype" ? performance : null;
      res[name] = {
        own: Object.getOwnPropertyNames(obj),
        symbols: Object.getOwnPropertySymbols(obj).map(String),
        tag: Object.prototype.toString.call(obj),
        ctor: tryGet(() => obj.constructor && obj.constructor.name, null),
        shape: describeKeys(obj, instance),
      };
    }
    res.__chains = {
      window: tryGet(() => {
        const c = [];
        let o = window;
        while ((o = Object.getPrototypeOf(o))) c.push({ tag: Object.prototype.toString.call(o), ctor: o.constructor && o.constructor.name, own: Object.getOwnPropertyNames(o).length });
        return c;
      }, null),
      document: tryGet(() => {
        const c = [];
        let o = document;
        while ((o = Object.getPrototypeOf(o))) c.push({ tag: Object.prototype.toString.call(o), ctor: o.constructor && o.constructor.name, own: Object.getOwnPropertyNames(o).length });
        return c;
      }, null),
    };
    out.protoShapes = res;
  }

  function collectKeys() {
    const res = {};
    const paths = RECIPE.keys.slice();
    for (const extra of ["window", "window.navigator", "window.navigator.__proto__", "window.document", "window.location", "window.screen", "window.history"]) {
      if (paths.indexOf(extra) < 0) paths.push(extra);
    }
    for (const path of paths) {
      const target = tryGet(() => resolvePath(path), undefined);
      if (target === undefined || target === null) {
        res[path] = null;
        continue;
      }
      res[path] = {
        own: Object.getOwnPropertyNames(target),
        enumerable: tryGet(() => {
          const k = [];
          for (const key in target) k.push(key);
          return k;
        }, []),
        symbols: Object.getOwnPropertySymbols(target).map(String),
        proto: Object.prototype.toString.call(target),
        shape: describeKeys(target, path.endsWith(".__proto__") ? tryGet(() => resolvePath(path.slice(0, -10)), null) : target),
      };
    }
    out.keys = res;
  }

  function collectAbsent() {
    for (const path of RECIPE.absent) out.absent[path] = tryGet(() => resolvePath(path), undefined) !== undefined;
  }

  async function collectEnv() {
    const n = navigator;
    const s = screen;
    out.scriptUrl = RECIPE.scriptUrl;
    out.pageUrl = location.href;
    out.seed = "real-" + Math.random().toString(36).slice(2, 10);
    out.userAgent = n.userAgent;
    out.appVersion = n.appVersion;
    out.appName = n.appName;
    out.appCodeName = n.appCodeName;
    out.product = n.product;
    out.productSub = n.productSub;
    out.vendor = n.vendor;
    out.vendorSub = n.vendorSub;
    out.platform = n.platform;
    out.oscpu = n.oscpu;
    out.language = n.language;
    out.languages = Array.prototype.slice.call(n.languages || []);
    out.hardwareConcurrency = n.hardwareConcurrency;
    out.deviceMemory = n.deviceMemory;
    out.maxTouchPoints = n.maxTouchPoints;
    out.cookieEnabled = n.cookieEnabled;
    out.pdfViewerEnabled = n.pdfViewerEnabled;
    out.onLine = n.onLine;
    out.webdriver = n.webdriver;
    out.doNotTrack = n.doNotTrack;
    out.globalPrivacyControl = n.globalPrivacyControl;
    out.brands = tryGet(() => JSON.parse(JSON.stringify(n.userAgentData.brands)), null);
    out.mobile = tryGet(() => n.userAgentData.mobile, null);
    out.highEntropy = await (async () => {
      try {
        return await n.userAgentData.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion", "uaFullVersion", "fullVersionList", "wow64", "formFactors"]);
      } catch (e) {
        return null;
      }
    })();
    out.screen = { width: s.width, height: s.height, availWidth: s.availWidth, availHeight: s.availHeight, availLeft: s.availLeft, availTop: s.availTop, colorDepth: s.colorDepth, pixelDepth: s.pixelDepth, orientation: tryGet(() => ({ type: s.orientation.type, angle: s.orientation.angle }), null), isExtended: s.isExtended };
    out.window = { innerWidth: innerWidth, innerHeight: innerHeight, outerWidth: outerWidth, outerHeight: outerHeight, devicePixelRatio: devicePixelRatio, screenX: screenX, screenY: screenY, scrollX: scrollX, scrollY: scrollY };
    out.timezoneOffset = new Date().getTimezoneOffset();
    out.timezone = tryGet(() => Intl.DateTimeFormat().resolvedOptions().timeZone, null);
    out.locale = tryGet(() => Intl.DateTimeFormat().resolvedOptions().locale, null);
    out.dateString = String(new Date());
    out.cookie = tryGet(() => document.cookie, null);
    out.referrer = tryGet(() => document.referrer, null);
    out.title = tryGet(() => document.title, null);
    out.lastModified = tryGet(() => document.lastModified, null);
    out.characterSet = tryGet(() => document.characterSet, null);
    out.compatMode = tryGet(() => document.compatMode, null);
    out.visibilityState = tryGet(() => document.visibilityState, null);
    out.connection = tryGet(() => ({ effectiveType: n.connection.effectiveType, rtt: n.connection.rtt, downlink: n.connection.downlink, saveData: n.connection.saveData, type: n.connection.type }), null);
    out.battery = await (async () => {
      try {
        const b = await n.getBattery();
        return { charging: b.charging, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime, level: b.level };
      } catch (e) {
        return null;
      }
    })();
    out.plugins = tryGet(() => Array.prototype.map.call(n.plugins, function (p) {
      return { name: p.name, filename: p.filename, description: p.description, mimeTypes: Array.prototype.map.call(p, function (m) { return { type: m.type, suffixes: m.suffixes, description: m.description }; }) };
    }), []);
    out.mimeTypes = tryGet(() => Array.prototype.map.call(n.mimeTypes, function (m) {
      return { type: m.type, suffixes: m.suffixes, description: m.description, enabledPlugin: m.enabledPlugin ? m.enabledPlugin.name : null };
    }), []);
    out.navigationTiming = tryGet(() => JSON.parse(JSON.stringify(performance.getEntriesByType("navigation")[0])), null);
    out.memory = tryGet(() => ({ jsHeapSizeLimit: performance.memory.jsHeapSizeLimit, totalJSHeapSize: performance.memory.totalJSHeapSize, usedJSHeapSize: performance.memory.usedJSHeapSize }), null);
    out.chrome = tryGet(() => ({ app: Object.keys(window.chrome.app), keys: Object.keys(window.chrome), csi: window.chrome.csi(), loadTimes: window.chrome.loadTimes() }), null);
    out.mediaQueries = (function () {
      const res = {};
      const list = [
        "(prefers-color-scheme: dark)", "(prefers-color-scheme: light)", "(hover: hover)", "(any-hover: hover)",
        "(pointer: fine)", "(pointer: coarse)", "(any-pointer: fine)", "(prefers-reduced-motion: reduce)",
        "(prefers-contrast: more)", "(forced-colors: active)", "(display-mode: browser)", "(display-mode: standalone)",
        "(orientation: landscape)", "(orientation: portrait)", "(min-resolution: 2dppx)", "(color-gamut: srgb)",
        "(color-gamut: p3)", "(dynamic-range: high)", "(inverted-colors: inverted)", "(monochrome)", "(scripting: enabled)",
      ];
      for (const q of list) res[q] = tryGet(() => matchMedia(q).matches, null);
      return res;
    })();
    out.computedStyle = tryGet(() => {
      const d = document.createElement("div");
      document.body.appendChild(d);
      const cs = getComputedStyle(d);
      const keys = ["fontFamily", "fontSize", "color", "backgroundColor", "display", "direction", "textAlign", "lineHeight", "writingMode", "zoom", "appearance", "colorScheme", "opacity", "visibility", "position", "width", "height", "transform", "filter", "mixBlendMode", "perspective", "fontStretch", "fontWeight", "fontStyle", "textRendering", "webkitFontSmoothing"];
      const res = {};
      for (const k of keys) res[k] = cs[k];
      res.length = cs.length;
      d.remove();
      return res;
    }, null);
    out.storageKeys = tryGet(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }), null);
    out.navigationType = tryGet(() => performance.getEntriesByType("navigation")[0].type, null);
    out.supportedEntryTypes = tryGet(() => Array.from(PerformanceObserver.supportedEntryTypes), null);
    out.resourceEntries = tryGet(() => performance.getEntriesByType("resource").map((e) => JSON.parse(JSON.stringify(e))), null);
    out.paintEntries = tryGet(() => performance.getEntriesByType("paint").map((e) => JSON.parse(JSON.stringify(e))), null);
    out.perfEntryTags = tryGet(() => performance.getEntries().map((e) => Object.prototype.toString.call(e)), null);
    out.voices = tryGet(() => speechSynthesis.getVoices().map((v) => ({ voiceURI: v.voiceURI, name: v.name, lang: v.lang, localService: v.localService, default: v.default })), null);
    out.pageAgeMs = Math.round(performance.now());
    out.fonts = tryGet(() => ({ size: document.fonts.size, status: document.fonts.status }), null);
  }

  async function main() {
    await collectEnv();
    collectKeys();
    collectProtoShapes();
    collectAbsent();
    collectCodecs();
    await collectPermissions();
    collectGl();

    for (const step of RECIPE.timeline) {
      const entry = RECIPE.entries[step.bucket][step.index];
      try {
        if (step.bucket === "canvas") runCanvasStep(entry, step.key);
        else if (step.bucket === "imageData") runImageDataStep(entry, step.key);
        else if (step.bucket === "glPixels") runGlPixelsStep(entry, step.key);
        else if (step.bucket === "text") runTextStep(entry, step.key);
        else if (step.bucket === "audio") await runAudioStep(entry, step.key);
      } catch (e) {
        warn.push(step.bucket + " " + step.key + ": " + (e && e.message));
      }
    }

    collectBlendTable();
    collectBlendSamples();
    collectEncoderSamples();

    out.meta.durationMs = Math.round(performance.now() - t0);
    out.meta.warnings = warn;
    window.__CASTLE_PROFILE = out;
    const json = JSON.stringify(out);
    const name = "castle_profile_" + Date.now() + ".json";
    try {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      warn.push("download failed: " + (e && e.message));
    }
    console.log("castle profile collected", {
      bytes: json.length,
      canvas: Object.keys(out.collected.canvas).length,
      text: Object.keys(out.collected.text).length,
      imageData: Object.keys(out.collected.imageData).length,
      glPixels: Object.keys(out.collected.glPixels).length,
      audio: Object.keys(out.collected.audio).length,
      warnings: warn.length,
      file: name,
      global: "__CASTLE_PROFILE",
    });
    if (warn.length) console.warn(warn);
    return out;
  }

  return main();
})();
