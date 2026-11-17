(function (bridge) {
  const P = JSON.parse(bridge.profile);
  const log = bridge.log;
  const G = globalThis;
  const intrinsics = new Set(Object.getOwnPropertyNames(G));
  const hostSet = new WeakSet();
  const toProxy = new WeakMap();
  const toTarget = new WeakMap();
  const nativeNames = new WeakMap();

  function describe(v) {
    const t = typeof v;
    if (v === null) return "null";
    if (t === "string") return "str:" + (v.length > 80 ? v.slice(0, 80) + "…(" + v.length + ")" : v);
    if (t === "number" || t === "boolean" || t === "undefined" || t === "bigint") return t + ":" + String(v);
    if (t === "function") return "fn:" + (nativeNames.get(toTarget.get(v) || v) || v.name || "?");
    if (Array.isArray(v)) return "array(" + v.length + ")";
    return "obj:" + (Object.prototype.toString.call(toTarget.get(v) || v).slice(8, -1));
  }

  function raw(v) {
    return (v && toTarget.get(v)) || v;
  }

  function host(obj, tag) {
    hostSet.add(obj);
    if (tag) Object.defineProperty(obj, Symbol.toStringTag, { value: tag, configurable: true });
    return obj;
  }

  function nfn(name, impl) {
    const f = function () {
      "use strict";
      return impl.apply(this, arguments);
    };
    Object.defineProperty(f, "name", { value: name, configurable: true });
    nativeNames.set(f, name);
    return host(f);
  }

  function wrap(target, path) {
    if (target === null || (typeof target !== "object" && typeof target !== "function")) return target;
    if (!hostSet.has(target)) return target;
    if (toProxy.has(target)) return toProxy.get(target);
    const p = new Proxy(target, {
      get(t, k) {
        if (typeof k === "symbol") return Reflect.get(t, k, t);
        const full = path + "." + k;
        if (!(k in t)) {
          if (t === winTarget && intrinsics.has(k)) {
            log("intrinsic", full, "");
            return G[k];
          }
          log("miss", full, "");
          return undefined;
        }
        const v = Reflect.get(t, k, toProxy.get(t) || t);
        log("get", full, describe(v));
        return wrap(v, full);
      },
      has(t, k) {
        const h = Reflect.has(t, k) || (t === winTarget && typeof k === "string" && intrinsics.has(k));
        log("has", path + "." + String(k), String(h));
        return h;
      },
      set(t, k, v) {
        log("set", path + "." + String(k), describe(v));
        return Reflect.set(t, k, v);
      },
      deleteProperty(t, k) {
        log("delete", path + "." + String(k), "");
        return Reflect.deleteProperty(t, k);
      },
      ownKeys(t) {
        log("keys", path, "");
        return Reflect.ownKeys(t);
      },
      getOwnPropertyDescriptor(t, k) {
        log("descriptor", path + "." + String(k), "");
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
      getPrototypeOf(t) {
        const pr = Reflect.getPrototypeOf(t);
        log("proto", path, describe(pr));
        return wrap(pr, path + ".__proto__");
      },
      apply(t, thisArg, args) {
        log("call", path, args.map(describe).join(" | "));
        return wrap(Reflect.apply(t, raw(thisArg), args.map(raw)), path + "()");
      },
      construct(t, args) {
        log("new", path, args.map(describe).join(" | "));
        return wrap(Reflect.construct(t, args.map(raw)), "new " + path);
      },
    });
    toProxy.set(target, p);
    toTarget.set(p, target);
    return p;
  }

  const origToString = Function.prototype.toString;
  Function.prototype.toString = new Proxy(origToString, {
    apply(t, thisArg, args) {
      const tg = raw(thisArg);
      if (nativeNames.has(tg)) {
        log("toString", nativeNames.get(tg), "");
        return "function " + nativeNames.get(tg) + "() { [native code] }";
      }
      return Reflect.apply(t, tg, args);
    },
  });
  nativeNames.set(Function.prototype.toString, "toString");

  const listeners = [];
  function eventTarget(obj, name) {
    obj.addEventListener = nfn("addEventListener", function (type, fn) {
      listeners.push({ owner: name, type, fn });
      log("listen", name + ":" + type, "");
    });
    obj.removeEventListener = nfn("removeEventListener", function () {});
    obj.dispatchEvent = nfn("dispatchEvent", function () {
      return true;
    });
    return obj;
  }

  const url = JSON.parse(bridge.parseUrl(P.pageUrl));
  const location = host({
    valueOf: nfn("valueOf", function () {
      return this;
    }),
    ancestorOrigins: host({ length: 0 }, "DOMStringList"),
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    assign: nfn("assign", function () {}),
    reload: nfn("reload", function () {}),
    replace: nfn("replace", function () {}),
    toString: nfn("toString", function () {
      return url.href;
    }),
  });
  try {
    Object.defineProperty(location, "valueOf", { enumerable: false });
  } catch (e) {}

  const state = new WeakMap();
  function st(o) {
    return state.get(raw(o)) || {};
  }
  function nmeth(name, impl) {
    const holder = {
      [name]() {
        "use strict";
        return impl.apply(this, arguments);
      },
    };
    const f = holder[name];
    nativeNames.set(f, name);
    return host(f);
  }
  function getter(obj, name, fn) {
    const g = nmeth("get " + name, fn);
    Object.defineProperty(obj, name, { get: g, configurable: true, enumerable: true });
  }
  function method(obj, name, fn) {
    Object.defineProperty(obj, name, { value: nmeth(name, fn), writable: true, configurable: true, enumerable: true });
  }

  const ifaces = {};
  function iface(name, parent, ctorImpl) {
    const ctor = nfn(
      name,
      ctorImpl ||
        function () {
          throw new TypeError("Illegal constructor");
        }
    );
    const proto = host(Object.create(parent || Object.prototype), name);
    Object.defineProperty(ctor, "prototype", { value: proto, writable: false, enumerable: false, configurable: false });
    Object.defineProperty(proto, "constructor", { value: ctor, writable: true, enumerable: false, configurable: true });
    ifaces[name] = ctor;
    return proto;
  }
  function inst(proto, s) {
    const o = host(Object.create(proto));
    state.set(o, s || {});
    return o;
  }
  function getters(proto, map) {
    for (const k of Object.keys(map)) {
      const v = map[k];
      getter(proto, k, typeof v === "function" ? v : function () {
        return v;
      });
    }
  }
  function resolved(v) {
    return Promise.resolve(v);
  }

  const eventTargetProto = iface("EventTarget");
  method(eventTargetProto, "addEventListener", function (type, fn) {
    const s = st(this);
    listeners.push({ owner: s.label || "node", type, fn, self: this });
    log("listen", (s.label || "node") + ":" + type, "");
  });
  method(eventTargetProto, "removeEventListener", function () {});
  method(eventTargetProto, "dispatchEvent", function () {
    return true;
  });
  method(eventTargetProto, "when", function () {
    return host({}, "Observable");
  });

  const nodeProto = iface("Node", eventTargetProto);
  getter(nodeProto, "parentNode", function () {
    return st(this).parent || null;
  });
  getter(nodeProto, "parentElement", function () {
    return st(this).parent || null;
  });
  getter(nodeProto, "firstChild", function () {
    const c = st(this).children || [];
    return c[0] || null;
  });
  getter(nodeProto, "lastChild", function () {
    const c = st(this).children || [];
    return c[c.length - 1] || null;
  });
  getter(nodeProto, "childNodes", function () {
    return host((st(this).children || []).slice(), "NodeList");
  });
  getter(nodeProto, "ownerDocument", function () {
    return document;
  });
  getter(nodeProto, "isConnected", function () {
    return !!st(this).parent;
  });
  function attach(parent, child, before) {
    const ps = st(parent);
    const cs = st(child);
    if (!ps.children) return child;
    if (cs.parent) {
      const old = st(cs.parent).children;
      const i = old.indexOf(raw(child));
      if (i >= 0) old.splice(i, 1);
    }
    const i = before ? ps.children.indexOf(raw(before)) : -1;
    if (i >= 0) ps.children.splice(i, 0, raw(child));
    else ps.children.push(raw(child));
    cs.parent = raw(parent);
    log("attach", (ps.label || "node") + " <- " + (cs.label || "node"), "");
    if (cs.tag === "iframe") {
      bridge.schedule(function () {
        listeners.filter((l) => raw(l.self) === raw(child) && l.type === "load").forEach((l) => {
          log("fire", cs.label + ":load", "");
          try {
            l.fn.call(child, host({ type: "load", target: child }, "Event"));
          } catch (e) {
            bridge.error("iframe load", e);
          }
        });
      }, 1, false);
    }
    return child;
  }
  method(nodeProto, "appendChild", function (c) {
    return attach(this, c, null);
  });
  method(nodeProto, "insertBefore", function (c, ref) {
    return attach(this, c, ref);
  });
  method(nodeProto, "removeChild", function (c) {
    const ps = st(this);
    const cs = st(c);
    if (ps.children) {
      const i = ps.children.indexOf(raw(c));
      if (i >= 0) ps.children.splice(i, 1);
    }
    cs.parent = null;
    return c;
  });
  method(nodeProto, "contains", function (c) {
    return (st(this).children || []).indexOf(raw(c)) >= 0;
  });

  const elementProto = iface("Element", nodeProto);
  getter(elementProto, "tagName", function () {
    return String(st(this).tag || "").toUpperCase();
  });
  getter(elementProto, "nodeName", function () {
    return String(st(this).tag || "").toUpperCase();
  });
  getter(elementProto, "children", function () {
    return host((st(this).children || []).slice(), "HTMLCollection");
  });
  getter(elementProto, "id", function () {
    return (st(this).attrs || {}).id || "";
  });
  method(elementProto, "setAttribute", function (k, v) {
    st(this).attrs[String(k)] = String(v);
  });
  method(elementProto, "getAttribute", function (k) {
    const v = (st(this).attrs || {})[String(k)];
    return v === undefined ? null : v;
  });
  method(elementProto, "hasAttribute", function (k) {
    return String(k) in (st(this).attrs || {});
  });
  method(elementProto, "removeAttribute", function (k) {
    delete st(this).attrs[String(k)];
  });
  method(elementProto, "getElementsByTagName", function () {
    return host([], "HTMLCollection");
  });
  method(elementProto, "querySelector", function () {
    return null;
  });
  method(elementProto, "querySelectorAll", function () {
    return host([], "NodeList");
  });
  method(elementProto, "getBoundingClientRect", function () {
    return host({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }, "DOMRect");
  });

  const htmlElementProto = iface("HTMLElement", elementProto);
  getter(htmlElementProto, "style", function () {
    return st(this).style;
  });
  getter(htmlElementProto, "offsetWidth", function () {
    return 0;
  });
  getter(htmlElementProto, "offsetHeight", function () {
    return 0;
  });

  const tagClass = {
    html: "HTMLHtmlElement",
    head: "HTMLHeadElement",
    body: "HTMLBodyElement",
    script: "HTMLScriptElement",
    iframe: "HTMLIFrameElement",
    div: "HTMLDivElement",
    span: "HTMLSpanElement",
    canvas: "HTMLCanvasElement",
    a: "HTMLAnchorElement",
    img: "HTMLImageElement",
    input: "HTMLInputElement",
    video: "HTMLVideoElement",
    audio: "HTMLAudioElement",
  };
  const tagProtos = {};
  function protoFor(tag) {
    const cls = tagClass[tag] || "HTMLUnknownElement";
    if (!tagProtos[cls]) {
      const p = iface(cls, htmlElementProto);
      if (cls === "HTMLIFrameElement") {
        getter(p, "contentWindow", function () {
          const s = st(this);
          if (!s.parent) return null;
          if (s.realm === undefined) s.realm = bridge.realm ? bridge.realm() : null;
          return s.realm || winTarget;
        });
        getter(p, "contentDocument", function () {
          const s = st(this);
          if (!s.parent) return null;
          if (s.realm === undefined) s.realm = bridge.realm ? bridge.realm() : null;
          if (s.realm) {
            try {
              return s.realm.document;
            } catch (e) {
              return document;
            }
          }
          return document;
        });
      }
      if (cls === "HTMLScriptElement") {
        getter(p, "src", function () {
          return (st(this).attrs || {}).src || "";
        });
      }
      if (cls === "HTMLCanvasElement") {
        Object.defineProperty(p, "width", {
          get: nfn("get width", function () {
            return st(this).width === undefined ? 300 : st(this).width;
          }),
          set: nfn("set width", function (v) {
            const s = st(this);
            s.width = Number(v) | 0;
            (s.ops = s.ops || []).push(["size", "width", s.width]);
          }),
          enumerable: true,
          configurable: true,
        });
        Object.defineProperty(p, "height", {
          get: nfn("get height", function () {
            return st(this).height === undefined ? 150 : st(this).height;
          }),
          set: nfn("set height", function (v) {
            const s = st(this);
            s.height = Number(v) | 0;
            (s.ops = s.ops || []).push(["size", "height", s.height]);
          }),
          enumerable: true,
          configurable: true,
        });
        method(p, "getContext", function (type, attrs) {
          const s = st(this);
          const t = String(type);
          s.contexts = s.contexts || {};
          if (s.contexts[t]) return s.contexts[t];
          let ctx = null;
          if (t === "2d") ctx = context2d(this);
          else if (t === "webgl" || t === "experimental-webgl") ctx = webgl(this, 1);
          else if (t === "webgl2") ctx = webgl(this, 2);
          if (ctx) s.contexts[t] = ctx;
          return ctx;
        });
        method(p, "toDataURL", function (type, quality) {
          const s = st(this);
          return bridge.canvasData(JSON.stringify({ w: s.width === undefined ? 300 : s.width, h: s.height === undefined ? 150 : s.height, type: type || "image/png", quality: quality === undefined ? null : quality, ops: s.ops || [] }));
        });
        method(p, "toBlob", function (cb) {
          bridge.schedule(function () {
            cb(host({ size: 2048, type: "image/png" }, "Blob"));
          }, 1, false);
        });
      }
      if (cls === "HTMLVideoElement" || cls === "HTMLAudioElement") {
        method(p, "canPlayType", function (t) {
          const v = String(t).toLowerCase().replace(/\s+/g, "");
          let r = "";
          if (/^(video|audio)\/mp4/.test(v) || /^audio\/mpeg/.test(v) || /^audio\/aac/.test(v) || /^audio\/x-m4a/.test(v)) r = /codecs/.test(v) ? "probably" : "maybe";
          else if (/^(video|audio)\/webm/.test(v)) r = /codecs/.test(v) ? (/vp8|vp9|vorbis|opus|av01/.test(v) ? "probably" : "") : "maybe";
          else if (/^audio\/ogg/.test(v)) r = /codecs/.test(v) ? (/vorbis|opus|flac/.test(v) ? "probably" : "") : "maybe";
          else if (/^audio\/(wav|x-wav)/.test(v)) r = /codecs="?1"?/.test(v) ? "probably" : "maybe";
          else if (/^audio\/flac/.test(v)) r = "probably";
          else if (/^video\/ogg/.test(v)) r = "";
          log("canPlayType", String(t), r);
          return r;
        });
      }
      tagProtos[cls] = p;
    }
    return tagProtos[cls];
  }

  function element(tag) {
    tag = String(tag).toLowerCase();
    const el = host(Object.create(protoFor(tag)));
    state.set(el, { tag, label: "element:" + tag, attrs: {}, children: [], parent: null, style: host({}, "CSSStyleDeclaration") });
    return el;
  }

  function short(v) {
    if (typeof v === "number" || typeof v === "boolean" || v == null) return v;
    if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) : v;
    const t = raw(v);
    if (t && ArrayBuffer.isView(t) && !(t instanceof DataView)) {
      const kind = Object.prototype.toString.call(t).slice(8, -1);
      if (t.length <= 512) return kind + "[" + Array.prototype.join.call(t, ",") + "]";
      return kind + "(" + t.length + ")";
    }
    return describe(v);
  }
  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  let ctx2dProto = null;
  function context2d(canvas) {
    if (!ctx2dProto) {
      ctx2dProto = iface("CanvasRenderingContext2D");
      const props = {
        fillStyle: "#000000",
        strokeStyle: "#000000",
        font: "10px sans-serif",
        textAlign: "start",
        textBaseline: "alphabetic",
        direction: "ltr",
        globalAlpha: 1,
        globalCompositeOperation: "source-over",
        lineWidth: 1,
        lineCap: "butt",
        lineJoin: "miter",
        miterLimit: 10,
        shadowBlur: 0,
        shadowColor: "rgba(0, 0, 0, 0)",
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "low",
        filter: "none",
        letterSpacing: "0px",
        wordSpacing: "0px",
        fontKerning: "auto",
        textRendering: "auto",
      };
      Object.keys(props).forEach(function (k) {
        Object.defineProperty(ctx2dProto, k, {
          get: nfn("get " + k, function () {
            const s = st(this);
            return k in s.props ? s.props[k] : props[k];
          }),
          set: nfn("set " + k, function (v) {
            const s = st(this);
            s.props[k] = typeof v === "object" ? v : String(v) === String(Number(v)) && typeof props[k] === "number" ? Number(v) : v;
            st(s.canvas).ops.push(["set", k, short(v)]);
          }),
          enumerable: true,
          configurable: true,
        });
      });
      getter(ctx2dProto, "canvas", function () {
        return st(this).canvas;
      });
      const drawOps = ["fillRect", "strokeRect", "clearRect", "fillText", "strokeText", "beginPath", "closePath", "moveTo", "lineTo", "arc", "arcTo", "ellipse", "rect", "roundRect", "quadraticCurveTo", "bezierCurveTo", "fill", "stroke", "clip", "save", "restore", "translate", "rotate", "scale", "transform", "setTransform", "resetTransform", "drawImage", "putImageData", "setLineDash", "reset"];
      drawOps.forEach(function (name) {
        method(ctx2dProto, name, function () {
          st(st(this).canvas).ops.push([name].concat(Array.prototype.map.call(arguments, short)));
        });
      });
      method(ctx2dProto, "isPointInPath", function () {
        const args = Array.prototype.map.call(arguments, short);
        st(st(this).canvas).ops.push(["isPointInPath"].concat(args));
        return args[args.length - 1] === "evenodd" ? false : true;
      });
      method(ctx2dProto, "isPointInStroke", function () {
        return false;
      });
      method(ctx2dProto, "getLineDash", function () {
        return [];
      });
      method(ctx2dProto, "getTransform", function () {
        return host({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, is2D: true, isIdentity: true }, "DOMMatrix");
      });
      method(ctx2dProto, "measureText", function (text) {
        const s = st(this);
        const font = k2(s, "font");
        const w = bridge.textWidth(font, String(text));
        st(s.canvas).ops.push(["measureText", short(String(text)), font]);
        const size = parseFloat((font.match(/([\d.]+)px/) || [0, 10])[1]);
        const real = bridge.textMetrics ? bridge.textMetrics(font, String(text)) : null;
        if (real)
          return host(
            {
              width: real[0],
              actualBoundingBoxLeft: real[1],
              actualBoundingBoxRight: real[2],
              actualBoundingBoxAscent: real[3],
              actualBoundingBoxDescent: real[4],
              fontBoundingBoxAscent: real[5],
              fontBoundingBoxDescent: real[6],
              emHeightAscent: real[7] === null ? undefined : real[7],
              emHeightDescent: real[8] === null ? undefined : real[8],
              hangingBaseline: real[9],
              alphabeticBaseline: real[10],
              ideographicBaseline: real[11],
            },
            "TextMetrics"
          );
        return host(
          {
            width: w,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: w,
            actualBoundingBoxAscent: size * 0.72,
            actualBoundingBoxDescent: size * 0.21,
            fontBoundingBoxAscent: size * 0.91,
            fontBoundingBoxDescent: size * 0.21,
            emHeightAscent: size * 0.8,
            emHeightDescent: size * 0.2,
            hangingBaseline: size * 0.7,
            alphabeticBaseline: 0,
            ideographicBaseline: -size * 0.21,
          },
          "TextMetrics"
        );
      });
      function k2(s, k) {
        return k in s.props ? s.props[k] : props[k];
      }
      function gradient() {
        return host({ addColorStop: nfn("addColorStop", function () {}) }, "CanvasGradient");
      }
      method(ctx2dProto, "createLinearGradient", gradient);
      method(ctx2dProto, "createRadialGradient", gradient);
      method(ctx2dProto, "createConicGradient", gradient);
      method(ctx2dProto, "createPattern", function () {
        return host({ setTransform: nfn("setTransform", function () {}) }, "CanvasPattern");
      });
      function imageData(w, h, seed) {
        const data = new Uint8ClampedArray(w * h * 4);
        let x = seed || 1;
        for (let i = 0; i < data.length; i++) {
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          data[i] = x & 255;
        }
        return host({ width: w, height: h, data, colorSpace: "srgb" }, "ImageData");
      }
      method(ctx2dProto, "getImageData", function (x, y, w, h) {
        const cs = st(st(this).canvas);
        const spec = JSON.stringify({ cw: cs.width === undefined ? 300 : cs.width, ch: cs.height === undefined ? 150 : cs.height, x: x | 0, y: y | 0, w: w | 0, h: h | 0, ops: cs.ops || [] });
        const got = bridge.imageData ? bridge.imageData(spec) : null;
        if (got) {
          const bin = bridge.atob(got);
          const data = new Uint8ClampedArray(bin.length);
          for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
          return host({ width: w | 0, height: h | 0, data, colorSpace: "srgb" }, "ImageData");
        }
        return imageData(w | 0, h | 0, fnv(bridge.seed + spec));
      });
      method(ctx2dProto, "createImageData", function (w, h) {
        return host({ width: w | 0, height: h | 0, data: new Uint8ClampedArray((w | 0) * (h | 0) * 4), colorSpace: "srgb" }, "ImageData");
      });
      method(ctx2dProto, "getContextAttributes", function () {
        return { alpha: true, colorSpace: "srgb", desynchronized: false, willReadFrequently: false };
      });
    }
    const cs = st(canvas);
    cs.ops = cs.ops || [];
    return inst(ctx2dProto, { canvas: raw(canvas), props: {} });
  }

  const glProtos = {};
  function webgl(canvas, version) {
    const name = version === 2 ? "WebGL2RenderingContext" : "WebGLRenderingContext";
    if (!glProtos[name]) {
      const p = iface(name);
      const consts = { DEPTH_BUFFER_BIT: 256, STENCIL_BUFFER_BIT: 1024, COLOR_BUFFER_BIT: 16384, POINTS: 0, LINES: 1, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6, ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963, STATIC_DRAW: 35044, FLOAT: 5126, UNSIGNED_BYTE: 5121, UNSIGNED_SHORT: 5123, VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713, LINK_STATUS: 35714, LOW_FLOAT: 36336, MEDIUM_FLOAT: 36337, HIGH_FLOAT: 36338, LOW_INT: 36339, MEDIUM_INT: 36340, HIGH_INT: 36341, VENDOR: 7936, RENDERER: 7937, VERSION: 7938, SHADING_LANGUAGE_VERSION: 35724, MAX_TEXTURE_SIZE: 3379, MAX_VIEWPORT_DIMS: 3386, MAX_VERTEX_ATTRIBS: 34921, MAX_VERTEX_UNIFORM_VECTORS: 36347, MAX_VARYING_VECTORS: 36348, MAX_FRAGMENT_UNIFORM_VECTORS: 36349, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661, MAX_TEXTURE_IMAGE_UNITS: 34930, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 35660, MAX_CUBE_MAP_TEXTURE_SIZE: 34076, MAX_RENDERBUFFER_SIZE: 34024, ALIASED_LINE_WIDTH_RANGE: 33902, ALIASED_POINT_SIZE_RANGE: 33901, RED_BITS: 3410, GREEN_BITS: 3411, BLUE_BITS: 3412, ALPHA_BITS: 3413, DEPTH_BITS: 3414, STENCIL_BITS: 3415, RGBA: 6408 };
      Object.keys(consts).forEach(function (k) {
        Object.defineProperty(p, k, { value: consts[k], enumerable: true });
      });
      getters(p, {
        canvas: function () {
          return st(this).canvas;
        },
        drawingBufferWidth: function () {
          return 300;
        },
        drawingBufferHeight: function () {
          return 150;
        },
        drawingBufferColorSpace: "srgb",
      });
      const W = P.webgl || {};
      const params = Object.assign(
        {
          7936: "WebKit",
          7937: "WebKit WebGL",
          7938: version === 2 ? "WebGL 2.0 (OpenGL ES 3.0 Chromium)" : "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
          35724: version === 2 ? "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)" : "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
          37445: W.unmaskedVendor || "Google Inc. (NVIDIA)",
          37446: W.unmaskedRenderer || "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)",
          3379: 16384,
          3386: ["Int32Array", 32767, 32767],
          34921: 16,
          36347: 4096,
          36348: 30,
          36349: 1024,
          35661: 32,
          34930: 16,
          35660: 16,
          34076: 16384,
          34024: 16384,
          33902: ["Float32Array", 1, 1],
          33901: ["Float32Array", 1, 1024],
          3410: 8,
          3411: 8,
          3412: 8,
          3413: 8,
          3414: 24,
          3415: 0,
          34047: 16,
        },
        W.params || {}
      );
      method(p, "getParameter", function (pname) {
        const v = params[pname];
        log("glParam", String(pname), v === undefined ? "undefined" : JSON.stringify(v));
        if (Array.isArray(v)) return v[0] === "Int32Array" ? new Int32Array(v.slice(1)) : new Float32Array(v.slice(1));
        return v === undefined ? null : v;
      });
      const versionKey = version === 2 ? "webgl2" : "webgl";
      const byVersion = P.webglByVersion || {};
      const vinfo = byVersion[versionKey] || {};
      const extObjects = vinfo.extensionObjects || {};
      const exts = vinfo.supportedExtensions || W.extensions || ["ANGLE_instanced_arrays", "EXT_blend_minmax", "EXT_clip_control", "EXT_color_buffer_half_float", "EXT_depth_clamp", "EXT_disjoint_timer_query", "EXT_float_blend", "EXT_frag_depth", "EXT_polygon_offset_clamp", "EXT_shader_texture_lod", "EXT_texture_compression_bptc", "EXT_texture_compression_rgtc", "EXT_texture_filter_anisotropic", "EXT_texture_mirror_clamp_to_edge", "EXT_sRGB", "KHR_parallel_shader_compile", "OES_element_index_uint", "OES_fbo_render_mipmap", "OES_standard_derivatives", "OES_texture_float", "OES_texture_float_linear", "OES_texture_half_float", "OES_texture_half_float_linear", "OES_vertex_array_object", "WEBGL_blend_func_extended", "WEBGL_color_buffer_float", "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_s3tc_srgb", "WEBGL_debug_renderer_info", "WEBGL_debug_shaders", "WEBGL_depth_texture", "WEBGL_draw_buffers", "WEBGL_lose_context", "WEBGL_multi_draw", "WEBGL_polygon_mode"];
      const extCache = {};
      function buildExt(name) {
        if (extCache[name] !== undefined) return extCache[name];
        const spec = extObjects[name];
        let obj = null;
        if (spec && typeof spec === "object") {
          const body = {};
          const props = spec.props || {};
          for (const key of Object.keys(props)) {
            const v = props[key];
            if (v && typeof v === "object" && v.fn !== undefined) {
              const f = nfn(v.fn, function () {});
              try {
                Object.defineProperty(f, "length", { value: v.length | 0, configurable: true });
              } catch (e) {}
              body[key] = f;
            } else {
              body[key] = v;
            }
          }
          obj = host(body, spec.tag || name);
        }
        extCache[name] = obj;
        return obj;
      }
      method(p, "getSupportedExtensions", function () {
        log("glSupportedExtensions", String(version), "");
        return exts.slice();
      });
      method(p, "getExtension", function (n) {
        const name = String(n);
        log("glExtension", name, "");
        if (exts.indexOf(name) < 0) return null;
        const built = buildExt(name);
        if (built) return built;
        if (name === "WEBGL_debug_renderer_info") return host({ UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 }, "WebGLDebugRendererInfo");
        if (name === "EXT_texture_filter_anisotropic") return host({ MAX_TEXTURE_MAX_ANISOTROPY_EXT: 34047, TEXTURE_MAX_ANISOTROPY_EXT: 34046 }, "EXTTextureFilterAnisotropic");
        if (name === "WEBGL_lose_context") return host({ loseContext: nfn("loseContext", function () {}), restoreContext: nfn("restoreContext", function () {}) }, "WebGLLoseContext");
        return host({}, name);
      });
      method(p, "getContextAttributes", function () {
        return Object.assign({ alpha: true, antialias: true, depth: true, desynchronized: false, failIfMajorPerformanceCaveat: false, powerPreference: "default", premultipliedAlpha: true, preserveDrawingBuffer: false, stencil: false, xrCompatible: false }, W.contextAttributes || {});
      });
      method(p, "getShaderPrecisionFormat", function (shader, type) {
        const isInt = type >= 36339;
        const key = String(shader) + ":" + String(type);
        const got = (W.shaderPrecision || {})[key];
        log("glPrecision", key, got ? JSON.stringify(got) : "");
        if (got) return host({ rangeMin: got[0], rangeMax: got[1], precision: got[2] }, "WebGLShaderPrecisionFormat");
        return host({ rangeMin: isInt ? 31 : 127, rangeMax: isInt ? 30 : 127, precision: isInt ? 0 : 23 }, "WebGLShaderPrecisionFormat");
      });
      method(p, "isContextLost", function () {
        return false;
      });
      method(p, "getError", function () {
        return 0;
      });
      method(p, "getShaderParameter", function () {
        return true;
      });
      method(p, "getProgramParameter", function () {
        return true;
      });
      method(p, "getAttribLocation", function () {
        return 0;
      });
      method(p, "getUniformLocation", function () {
        return host({}, "WebGLUniformLocation");
      });
      ["createBuffer", "createProgram", "createShader", "createTexture", "createFramebuffer", "createRenderbuffer"].forEach(function (n) {
        method(p, n, function () {
          return host({}, n.replace("create", "WebGL"));
        });
      });
      ["bindBuffer", "bufferData", "shaderSource", "compileShader", "attachShader", "linkProgram", "useProgram", "enableVertexAttribArray", "vertexAttribPointer", "uniform1f", "uniform2f", "uniform4fv", "uniformMatrix4fv", "drawArrays", "drawElements", "clearColor", "clear", "viewport", "enable", "disable", "blendFunc", "deleteBuffer", "deleteProgram", "deleteShader", "bindTexture", "texImage2D", "texParameteri", "bindFramebuffer", "pixelStorei"].forEach(function (n) {
        method(p, n, function () {
          st(st(this).canvas).ops.push(["gl." + n].concat(Array.prototype.map.call(arguments, short)));
        });
      });
      method(p, "readPixels", function (x, y, w, h, f, t, buf) {
        const b = raw(buf);
        const cs = st(st(this).canvas);
        const spec = JSON.stringify({ version: version, cw: cs.width === undefined ? 300 : cs.width, ch: cs.height === undefined ? 150 : cs.height, x: x | 0, y: y | 0, w: w | 0, h: h | 0, format: f, type: t, len: b.length, ops: cs.ops || [] });
        const got = bridge.glPixels ? bridge.glPixels(spec) : null;
        if (got) {
          const bin = bridge.atob(got);
          for (let i = 0; i < b.length && i < bin.length; i++) b[i] = bin.charCodeAt(i);
          return;
        }
        let s = fnv(bridge.seed + spec);
        for (let i = 0; i < b.length; i++) {
          s ^= s << 13;
          s ^= s >>> 17;
          s ^= s << 5;
          b[i] = s & 255;
        }
      });
      glProtos[name] = p;
    }
    const cs = st(canvas);
    cs.ops = cs.ops || [];
    return inst(glProtos[name], { canvas: raw(canvas) });
  }

  function audioParam(v) {
    const p = host({ value: v, defaultValue: v, minValue: -3.4028234663852886e38, maxValue: 3.4028234663852886e38, automationRate: "a-rate" }, "AudioParam");
    ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime", "setTargetAtTime", "cancelScheduledValues"].forEach(function (n) {
      p[n] = nfn(n, function (val) {
        if (n === "setValueAtTime") p.value = val;
        return p;
      });
    });
    return p;
  }
  function audioNode(tag, extra, ctx) {
    const n = host(Object.assign({ context: ctx, numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "max", channelInterpretation: "speakers" }, extra), tag);
    const owner = ctx ? st(raw(ctx)) : null;
    const label = tag + "#" + (owner && owner.nodes ? owner.nodes.length + 1 : 1);
    Object.defineProperty(n, "__label", { value: label });
    if (ctx) {
      const cs = st(raw(ctx));
      if (cs && cs.nodes) cs.nodes.push(n);
    }
    n.connect = nfn("connect", function (d) {
      const t = raw(d);
      if (ctx) {
        const cs = st(raw(ctx));
        if (cs && cs.edges) cs.edges.push([label, (t && t.__label) || "destination"]);
      }
      return d;
    });
    n.disconnect = nfn("disconnect", function () {});
    n.start = nfn("start", function () {});
    n.stop = nfn("stop", function () {});
    return n;
  }
  const audioBufferProto = iface("AudioBuffer");
  getters(audioBufferProto, {
    length: function () {
      return st(this).length;
    },
    sampleRate: function () {
      return st(this).sampleRate;
    },
    numberOfChannels: function () {
      return st(this).channels.length;
    },
    duration: function () {
      return st(this).length / st(this).sampleRate;
    },
  });
  method(audioBufferProto, "getChannelData", function (c) {
    return st(this).channels[c | 0];
  });
  method(audioBufferProto, "copyFromChannel", function (dest, c, start) {
    const src = st(this).channels[c | 0];
    raw(dest).set(src.subarray(start || 0, (start || 0) + raw(dest).length));
  });
  const offlineProto = iface("OfflineAudioContext", eventTargetProto, function (a, b, c) {
    const o = typeof a === "object" && a ? a : { numberOfChannels: a, length: b, sampleRate: c };
    const ctx = inst(offlineProto, { label: "audio", channels: o.numberOfChannels || 1, length: o.length | 0, sampleRate: o.sampleRate || 44100, graph: [], nodes: [], edges: [] });
    log("audio", "new OfflineAudioContext", JSON.stringify(o));
    return ctx;
  });
  getters(offlineProto, {
    length: function () {
      return st(this).length;
    },
    sampleRate: function () {
      return st(this).sampleRate;
    },
    currentTime: 0,
    state: "suspended",
    destination: function () {
      const s = st(this);
      s.dest = s.dest || audioNode("AudioDestinationNode", { maxChannelCount: s.channels, numberOfOutputs: 0 }, this);
      return s.dest;
    },
  });
  method(offlineProto, "createOscillator", function () {
    st(this).graph.push("oscillator");
    return audioNode("OscillatorNode", { type: "sine", frequency: audioParam(440), detune: audioParam(0), numberOfInputs: 0 }, this);
  });
  method(offlineProto, "createDynamicsCompressor", function () {
    st(this).graph.push("compressor");
    return audioNode("DynamicsCompressorNode", { threshold: audioParam(-24), knee: audioParam(30), ratio: audioParam(12), attack: audioParam(0.003), release: audioParam(0.25), reduction: 0 }, this);
  });
  method(offlineProto, "createGain", function () {
    return audioNode("GainNode", { gain: audioParam(1) }, this);
  });
  method(offlineProto, "createBiquadFilter", function () {
    return audioNode("BiquadFilterNode", { type: "lowpass", frequency: audioParam(350), Q: audioParam(1), gain: audioParam(0), detune: audioParam(0) }, this);
  });
  method(offlineProto, "createAnalyser", function () {
    return audioNode("AnalyserNode", { fftSize: 2048, frequencyBinCount: 1024 }, this);
  });
  function audioGraph(s) {
    const nodes = s.nodes.map(function (n) {
      const d = { label: n.__label, kind: Object.prototype.toString.call(n).slice(8, -1) };
      ["type", "fftSize"].forEach(function (k) {
        if (n[k] !== undefined) d[k] = n[k];
      });
      ["frequency", "detune", "gain", "Q", "threshold", "knee", "ratio", "attack", "release"].forEach(function (k) {
        if (n[k] && typeof n[k] === "object" && "value" in n[k]) d[k] = n[k].value;
      });
      return d;
    });
    return { nodes: nodes, edges: s.edges };
  }
  method(offlineProto, "startRendering", function () {
    const self = this;
    const s = st(this);
    const chans = [];
    const g = audioGraph(s);
    for (let c = 0; c < s.channels; c++) {
      chans.push(Float32Array.from(JSON.parse(bridge.audioSamples(JSON.stringify({ length: s.length, sampleRate: s.sampleRate, channels: s.channels, graph: s.graph, nodes: g.nodes, edges: g.edges, channel: c })))));
    }
    const buffer = inst(audioBufferProto, { length: s.length, sampleRate: s.sampleRate, channels: chans });
    log("audio", "startRendering", JSON.stringify({ length: s.length, graph: s.graph }));
    bridge.schedule(function () {
      const ev = host({ type: "complete", renderedBuffer: buffer }, "OfflineAudioCompletionEvent");
      if (typeof raw(self).oncomplete === "function") raw(self).oncomplete(ev);
    }, 2, false);
    return resolved(buffer);
  });

  function textNode(text) {
    const node = host({ nodeType: 3, nodeName: "#text", __observers: [] }, "Text");
    let data = String(text);
    function changed() {
      node.__observers.forEach(function (o) {
        Promise.resolve().then(function () {
          try {
            o._cb.call(null, host([host({ type: "characterData", target: node })]), o);
          } catch (e) {
            bridge.error("mutation callback", e);
          }
        });
      });
    }
    ["data", "nodeValue", "textContent"].forEach(function (k) {
      Object.defineProperty(node, k, {
        configurable: true,
        enumerable: true,
        get() {
          return data;
        },
        set(v) {
          data = String(v);
          changed();
        },
      });
    });
    return node;
  }

  const scriptEl = element("script");
  st(scriptEl).attrs.src = P.scriptUrl;
  const html = element("html");
  const head = element("head");
  const body = element("body");
  st(html).parent = null;
  st(html).children.push(head, body);
  st(head).parent = html;
  st(body).parent = html;
  (function () {
    const spec = P.dom || {};
    let placed = false;
    function build(parentEl, list) {
      for (const entry of list || []) {
        const tag = String(entry.tag || "div").toLowerCase();
        const attrs = entry.attrs || {};
        let el;
        if (tag === "script" && !placed && attrs.src && String(P.scriptUrl || "").indexOf(String(attrs.src)) >= 0) {
          el = scriptEl;
          placed = true;
        } else if (tag === "script" && !placed && attrs.src && String(attrs.src) === String(P.scriptUrl)) {
          el = scriptEl;
          placed = true;
        } else {
          el = element(tag);
        }
        const s = st(raw(el));
        for (const k of Object.keys(attrs)) s.attrs[k] = String(attrs[k]);
        if (entry.text !== undefined) s.text = String(entry.text);
        s.parent = raw(parentEl);
        st(raw(parentEl)).children.push(raw(el));
      }
    }
    build(head, spec.head);
    build(body, spec.body);
    if (!placed) {
      st(head).children.push(scriptEl);
      st(scriptEl).parent = head;
    }
  })();

  let cookieJar = P.cookie || "";
  const documentProto = iface("Document", nodeProto);
  const htmlDocumentProto = iface("HTMLDocument", documentProto);
  getters(documentProto, {
    readyState: "complete",
    visibilityState: "visible",
    hidden: false,
    referrer: P.referrer || "",
    title: P.title || "",
    characterSet: "UTF-8",
    charset: "UTF-8",
    inputEncoding: "UTF-8",
    contentType: "text/html",
    compatMode: "CSS1Compat",
    URL: url.href,
    documentURI: url.href,
    domain: url.hostname,
    currentScript: function () {
      return scriptEl;
    },
    documentElement: function () {
      return html;
    },
    head: function () {
      return head;
    },
    body: function () {
      return body;
    },
    scripts: function () {
      return host([scriptEl], "HTMLCollection");
    },
    defaultView: function () {
      return winTarget;
    },
    activeElement: function () {
      return body;
    },
    fullscreenEnabled: true,
    pictureInPictureEnabled: true,
    lastModified: P.lastModified || "11/16/2026 10:27:17",
    timeline: function () {
      return timeline;
    },
  });
  Object.defineProperty(documentProto, "cookie", {
    configurable: true,
    enumerable: true,
    get: nfn("get cookie", function () {
      return cookieJar;
    }),
    set: nfn("set cookie", function (v) {
      bridge.cookie(String(v));
      const pair = String(v).split(";")[0];
      const name = pair.split("=")[0];
      const parts = cookieJar ? cookieJar.split("; ").filter((c) => c.split("=")[0] !== name) : [];
      parts.push(pair);
      cookieJar = parts.join("; ");
    }),
  });
  method(documentProto, "createElement", function (tag) {
    return element(tag);
  });
  method(documentProto, "createElementNS", function (ns, tag) {
    return element(tag);
  });
  method(documentProto, "createTextNode", function (text) {
    return textNode(text);
  });
  method(documentProto, "createEvent", function (type) {
    const t = String(type);
    if (/^touchevent$/i.test(t)) {
      const err = new Error("Failed to execute 'createEvent' on 'Document': The provided event type ('" + t + "') is invalid.");
      err.name = "NotSupportedError";
      throw err;
    }
    return host({ type: "", initEvent: nfn("initEvent", function () {}) }, t);
  });
  method(documentProto, "getElementsByTagName", function (tag) {
    const t = String(tag).toLowerCase();
    const map = { script: [scriptEl], html: [html], head: [head], body: [body] };
    return host((map[t] || []).slice(), "HTMLCollection");
  });
  method(documentProto, "getElementById", function () {
    return null;
  });
  method(documentProto, "querySelector", function () {
    return null;
  });
  method(documentProto, "querySelectorAll", function () {
    return host([], "NodeList");
  });
  method(documentProto, "hasFocus", function () {
    return true;
  });
  const document = inst(htmlDocumentProto, { label: "document", children: [], parent: null });
  Object.defineProperty(document, "location", {
    get: nfn("get location", function () {
      return location;
    }),
    set: nfn("set location", function () {}),
    enumerable: true,
    configurable: false,
  });
  st(document).children.push(html);

  const pluginProto = iface("Plugin");
  const pluginArrayProto = iface("PluginArray");
  const mimeTypeProto = iface("MimeType");
  const mimeTypeArrayProto = iface("MimeTypeArray");
  const pdfNames = ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"];
  const mimeDefs = [
    { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
    { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" },
  ];
  getters(pluginProto, {
    name: function () {
      return st(this).name;
    },
    filename: "internal-pdf-viewer",
    description: "Portable Document Format",
    length: mimeDefs.length,
  });
  getters(mimeTypeProto, {
    type: function () {
      return st(this).type;
    },
    suffixes: "pdf",
    description: "Portable Document Format",
    enabledPlugin: function () {
      return plugins[0];
    },
  });
  const plugins = pdfNames.map((n) => inst(pluginProto, { name: n }));
  const mimes = mimeDefs.map((m) => inst(mimeTypeProto, { type: m.type }));
  function arrayLike(proto, items, keyOf) {
    const arr = inst(proto, {});
    items.forEach(function (it, i) {
      Object.defineProperty(arr, i, { value: it, enumerable: true, configurable: true });
    });
    items.forEach(function (it) {
      Object.defineProperty(arr, keyOf(it), { value: it, enumerable: false, configurable: true });
    });
    return arr;
  }
  [pluginArrayProto, mimeTypeArrayProto].forEach(function (p) {
    getter(p, "length", function () {
      return Object.keys(raw(this)).length;
    });
    method(p, "item", function (i) {
      return raw(this)[i] || null;
    });
    method(p, "namedItem", function (n) {
      return Object.getOwnPropertyDescriptor(raw(this), n) ? raw(this)[n] : null;
    });
  });
  method(pluginArrayProto, "refresh", function () {});
  [pluginProto, mimeTypeArrayProto].forEach(function (p) {
    if (typeof p.item !== "function") {
      method(p, "item", function (i) {
        return raw(this)[i] || null;
      });
    }
    if (typeof p.namedItem !== "function") {
      method(p, "namedItem", function (n) {
        return Object.getOwnPropertyDescriptor(raw(this), n) ? raw(this)[n] : null;
      });
    }
  });
  [pluginProto, pluginArrayProto, mimeTypeProto, mimeTypeArrayProto].forEach(function (p) {
    try {
      Object.defineProperty(p, Symbol.iterator, {
        value: nfn("[Symbol.iterator]", function () {
          const self = raw(this);
          let i = 0;
          return host({
            next: nfn("next", function () {
              const v = self[i++];
              return v === undefined ? host({ value: undefined, done: true }) : host({ value: v, done: false });
            }),
          });
        }),
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } catch (e) {}
  });
  const pluginArray = arrayLike(pluginArrayProto, plugins, (p) => st(p).name);
  const mimeTypeArray = arrayLike(mimeTypeArrayProto, mimes, (m) => st(m).type);
  plugins.forEach(function (p) {
    mimes.forEach(function (m, i) {
      Object.defineProperty(p, i, { value: m, enumerable: true, configurable: true });
      Object.defineProperty(p, st(m).type, { value: m, enumerable: false, configurable: true });
    });
  });

  const uaDataProto = iface("NavigatorUAData");
  const highEntropy = Object.assign(
    {
      architecture: "x86",
      bitness: "64",
      model: "",
      platformVersion: "10.0.0",
      uaFullVersion: "157.0.8103.51",
      wow64: false,
      formFactors: ["Desktop"],
      fullVersionList: [
        { brand: "Not-A.Brand", version: "99.0.0.0" },
        { brand: "Google Chrome", version: "157.0.8103.51" },
        { brand: "Chromium", version: "157.0.8103.51" },
      ],
    },
    P.highEntropy || {}
  );
  getters(uaDataProto, {
    brands: function () {
      return P.brands.map((b) => Object.assign({}, b));
    },
    mobile: false,
    platform: "Windows",
  });
  method(uaDataProto, "getHighEntropyValues", function (hints) {
    const outv = { brands: P.brands.map((b) => Object.assign({}, b)), mobile: false, platform: "Windows" };
    (hints || []).forEach(function (h) {
      if (h in highEntropy) outv[h] = JSON.parse(JSON.stringify(highEntropy[h]));
    });
    return resolved(outv);
  });
  method(uaDataProto, "toJSON", function () {
    return { brands: P.brands.map((b) => Object.assign({}, b)), mobile: false, platform: "Windows" };
  });
  const userAgentData = inst(uaDataProto);

  const permStatusProto = iface("PermissionStatus", eventTargetProto);
  getters(permStatusProto, {
    state: function () {
      return st(this).state;
    },
    name: function () {
      return st(this).name;
    },
    onchange: null,
  });
  const permissionsProto = iface("Permissions");
  const permDefaults = Object.assign({ notifications: "prompt", geolocation: "prompt", camera: "prompt", microphone: "prompt", "clipboard-read": "prompt", "clipboard-write": "granted", "persistent-storage": "prompt", push: "prompt", midi: "granted", "background-sync": "granted", accelerometer: "granted", gyroscope: "granted", magnetometer: "granted" }, P.permissions || {});
  method(permissionsProto, "query", function (desc) {
    const name = desc && desc.name;
    log("permission", String(name), permDefaults[name] || "?");
    if (!(name in permDefaults) || permDefaults[name] === "unsupported") {
      return Promise.reject(new TypeError("Failed to execute 'query' on 'Permissions': The provided value '" + name + "' is not a valid enum value of type PermissionName."));
    }
    return resolved(inst(permStatusProto, { state: permDefaults[name], name }));
  });
  const permissions = inst(permissionsProto);

  const connectionProto = iface("NetworkInformation", eventTargetProto);
  getters(connectionProto, Object.assign({ effectiveType: "4g", rtt: 50, downlink: 10, saveData: false, onchange: null }, P.connection || {}));
  const connection = inst(connectionProto, { label: "connection" });

  const batteryProto = iface("BatteryManager", eventTargetProto);
  getters(batteryProto, Object.assign({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1, onchargingchange: null, onlevelchange: null }, P.battery || {}));

  const gpuProto = iface("GPU");
  method(gpuProto, "requestAdapter", function () {
    return resolved(null);
  });
  method(gpuProto, "getPreferredCanvasFormat", function () {
    return "bgra8unorm";
  });
  getter(gpuProto, "wgslLanguageFeatures", function () {
    return host(new Set(), "WGSLLanguageFeatures");
  });
  const gpu = inst(gpuProto);

  const navigatorProto = iface("Navigator");
  getters(navigatorProto, {
    userAgent: P.userAgent,
    appVersion: P.appVersion,
    appName: "Netscape",
    appCodeName: "Mozilla",
    product: "Gecko",
    productSub: "20030107",
    vendor: P.vendor,
    vendorSub: "",
    platform: P.platform,
    language: P.language,
    languages: function () {
      return Object.freeze(P.languages.slice());
    },
    hardwareConcurrency: P.hardwareConcurrency,
    deviceMemory: P.deviceMemory,
    maxTouchPoints: P.maxTouchPoints,
    cookieEnabled: true,
    onLine: true,
    doNotTrack: null,
    webdriver: false,
    pdfViewerEnabled: true,
    plugins: function () {
      return pluginArray;
    },
    mimeTypes: function () {
      return mimeTypeArray;
    },
    userAgentData: function () {
      return userAgentData;
    },
    permissions: function () {
      return permissions;
    },
    connection: function () {
      return connection;
    },
    gpu: function () {
      return gpu;
    },
  });
  method(navigatorProto, "javaEnabled", function () {
    return false;
  });
  method(navigatorProto, "sendBeacon", function () {
    return true;
  });
  method(navigatorProto, "getBattery", function () {
    return resolved(inst(batteryProto, { label: "battery" }));
  });
  method(navigatorProto, "vibrate", function () {
    return true;
  });
  const navigator = inst(navigatorProto);

  const screenOrientationProto = iface("ScreenOrientation", eventTargetProto);
  getters(screenOrientationProto, { type: "landscape-primary", angle: 0, onchange: null });
  const screenProto = iface("Screen", eventTargetProto);
  getters(
    screenProto,
    Object.assign({ availLeft: 0, availTop: 0, isExtended: false, onchange: null }, P.screen, {
      orientation: function () {
        return orientation;
      },
    })
  );
  const orientation = inst(screenOrientationProto);
  const screen = inst(screenProto, { label: "screen" });

  const t0 = bridge.now();
  const timeOrigin = Date.now() - (P.pageAgeMs || 2100);
  const navEntryProto = iface("PerformanceNavigationTiming");
  const navTiming = Object.assign(
    {
      name: url.href,
      entryType: "navigation",
      startTime: 0,
      duration: 1350.5,
      initiatorType: "navigation",
      nextHopProtocol: "h2",
      workerStart: 0,
      redirectStart: 0,
      redirectEnd: 0,
      fetchStart: 3.1,
      domainLookupStart: 3.1,
      domainLookupEnd: 3.1,
      connectStart: 3.1,
      connectEnd: 3.1,
      secureConnectionStart: 3.1,
      requestStart: 6.4,
      responseStart: 412.2,
      responseEnd: 470.8,
      transferSize: 120300,
      encodedBodySize: 119900,
      decodedBodySize: 563669,
      unloadEventStart: 0,
      unloadEventEnd: 0,
      domInteractive: 980.3,
      domContentLoadedEventStart: 1180.6,
      domContentLoadedEventEnd: 1181.2,
      domComplete: 1349.9,
      loadEventStart: 1350.1,
      loadEventEnd: 1350.5,
      type: "navigate",
      redirectCount: 0,
      deliveryType: "",
      renderBlockingStatus: "non-blocking",
      responseStatus: 200,
    },
    P.navigationTiming || {}
  );
  getters(navEntryProto, navTiming);
  method(navEntryProto, "toJSON", function () {
    return Object.assign({}, navTiming);
  });
  const navEntry = inst(navEntryProto);
  const timingProto = iface("PerformanceTiming");
  const TIMING_FIELDS = [
    ["navigationStart", null],
    ["unloadEventStart", "unloadEventStart"],
    ["unloadEventEnd", "unloadEventEnd"],
    ["redirectStart", "redirectStart"],
    ["redirectEnd", "redirectEnd"],
    ["fetchStart", "fetchStart"],
    ["domainLookupStart", "domainLookupStart"],
    ["domainLookupEnd", "domainLookupEnd"],
    ["connectStart", "connectStart"],
    ["connectEnd", "connectEnd"],
    ["secureConnectionStart", "secureConnectionStart"],
    ["requestStart", "requestStart"],
    ["responseStart", "responseStart"],
    ["responseEnd", "responseEnd"],
    ["domLoading", "responseStart"],
    ["domInteractive", "domInteractive"],
    ["domContentLoadedEventStart", "domContentLoadedEventStart"],
    ["domContentLoadedEventEnd", "domContentLoadedEventEnd"],
    ["domComplete", "domComplete"],
    ["loadEventStart", "loadEventStart"],
    ["loadEventEnd", "loadEventEnd"],
  ];
  const ZERO_WHEN_ZERO = { unloadEventStart: 1, unloadEventEnd: 1, redirectStart: 1, redirectEnd: 1, secureConnectionStart: 1 };
  (function buildTimingProto() {
    const nav0 = P.navigationTiming || {};
    const map = {};
    for (const pair of TIMING_FIELDS) {
      const name = pair[0];
      const src = pair[1];
      map[name] = (function (nm, key) {
        return function () {
          if (key === null) return Math.round(timeOrigin);
          const off = Number(nav0[key]);
          if (!isFinite(off) || (off === 0 && ZERO_WHEN_ZERO[nm])) return 0;
          return Math.round(timeOrigin + off);
        };
      })(name, src);
    }
    getters(timingProto, map);
    method(timingProto, "toJSON", function () {
      const out = {};
      for (const pair of TIMING_FIELDS) out[pair[0]] = this[pair[0]];
      return out;
    });
  })();
  let timingInstance = null;
  function legacyTiming() {
    if (!timingInstance) timingInstance = inst(timingProto, { label: "performanceTiming" });
    return timingInstance;
  }
  const performanceProto = iface("Performance", eventTargetProto);
  getters(performanceProto, {
    timeOrigin: timeOrigin,
    timing: function () {
      return legacyTiming();
    },
    navigation: function () {
      return host({ type: 0, redirectCount: 0 }, "PerformanceNavigation");
    },
    memory: function () {
      return host({ jsHeapSizeLimit: 4294705152, totalJSHeapSize: 35000000, usedJSHeapSize: 28000000 }, "MemoryInfo");
    },
  });
  method(performanceProto, "now", function () {
    return Math.round((bridge.now() - t0 + (P.pageAgeMs || 2100)) * 10) / 10;
  });
  method(performanceProto, "getEntries", function () {
    return host([navEntry]);
  });
  method(performanceProto, "getEntriesByType", function (t) {
    return host(String(t) === "navigation" ? [navEntry] : []);
  });
  method(performanceProto, "getEntriesByName", function (n) {
    return host(String(n) === url.href ? [navEntry] : []);
  });
  method(performanceProto, "mark", function () {});
  method(performanceProto, "measure", function () {});
  method(performanceProto, "toJSON", function () {
    return { timeOrigin };
  });
  const performance = inst(performanceProto, { label: "performance" });

  const timelineProto = iface("DocumentTimeline", null, function () {
    return inst(timelineProto);
  });
  getter(timelineProto, "currentTime", function () {
    return performance.now();
  });
  const timeline = inst(timelineProto);

  const perfObsProto = iface("PerformanceObserver", null, function (cb) {
    return inst(perfObsProto, { cb });
  });
  Object.defineProperty(ifaces.PerformanceObserver, "supportedEntryTypes", {
    get: nfn("get supportedEntryTypes", function () {
      return Object.freeze(Array.isArray(P.supportedEntryTypes) && P.supportedEntryTypes.length ? P.supportedEntryTypes.map(String) : ["element", "event", "first-input", "interaction-contentful-paint", "largest-contentful-paint", "layout-shift", "long-animation-frame", "longtask", "mark", "measure", "navigation", "paint", "resource", "soft-navigation", "visibility-state"]);
    }),
    configurable: true,
  });
  method(perfObsProto, "observe", function () {});
  method(perfObsProto, "disconnect", function () {});
  method(perfObsProto, "takeRecords", function () {
    return host([]);
  });

  const navigationApiProto = iface("Navigation", eventTargetProto);
  const navHistEntryProto = iface("NavigationHistoryEntry", eventTargetProto);
  getters(navHistEntryProto, { url: url.href, key: "a1b2c3d4", id: "e5f6a7b8", index: 1, sameDocument: true });
  const navHistEntry = inst(navHistEntryProto);
  getters(navigationApiProto, {
    currentEntry: function () {
      return navHistEntry;
    },
    transition: null,
    canGoBack: true,
    canGoForward: false,
  });
  method(navigationApiProto, "entries", function () {
    return host([navHistEntry]);
  });
  const navigationApi = inst(navigationApiProto, { label: "navigation" });

  const externalProto = iface("External");
  method(externalProto, "AddSearchProvider", function () {});
  method(externalProto, "IsSearchProviderInstalled", function () {});
  const external = inst(externalProto);

  const idbFactoryProto = iface("IDBFactory");
  method(idbFactoryProto, "open", function () {
    return host({ readyState: "pending", result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null }, "IDBOpenDBRequest");
  });
  method(idbFactoryProto, "deleteDatabase", function () {
    return host({}, "IDBOpenDBRequest");
  });
  method(idbFactoryProto, "databases", function () {
    return resolved([]);
  });
  method(idbFactoryProto, "cmp", function (a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const indexedDB = inst(idbFactoryProto);

  iface("Worker", eventTargetProto, function () {
    log("worker", "new Worker", Array.prototype.map.call(arguments, describe).join(" | "));
    return inst(ifaces.Worker.prototype, { label: "worker" });
  });
  method(ifaces.Worker.prototype, "postMessage", function () {});
  method(ifaces.Worker.prototype, "terminate", function () {});
  iface("File", null, function (bits, name) {
    return inst(ifaces.File.prototype, { name });
  });
  iface("TouchEvent", null, function () {
    return inst(ifaces.TouchEvent.prototype, {});
  });
  iface("Notification", eventTargetProto, function () {
    return inst(ifaces.Notification.prototype, {});
  });
  Object.defineProperty(ifaces.Notification, "permission", {
    get: nfn("get permission", function () {
      return "default";
    }),
    configurable: true,
  });

  const chromeObj = host({
    app: host({
      isInstalled: false,
      getDetails: nfn("getDetails", function () {
        return null;
      }),
      getIsInstalled: nfn("getIsInstalled", function () {
        return false;
      }),
      installState: nfn("installState", function (cb) {
        if (typeof cb === "function") cb("not_installed");
      }),
      runningState: nfn("runningState", function () {
        return "cannot_run";
      }),
      InstallState: host({ DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }),
      RunningState: host({ CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" }),
    }),
    csi: nfn("csi", function () {
      return { startE: timeOrigin, onloadT: timeOrigin + 1350, pageT: performance.now(), tran: 15 };
    }),
    loadTimes: nfn("loadTimes", function () {
      const s = timeOrigin / 1000;
      return { requestTime: s, startLoadTime: s, commitLoadTime: s + 0.41, finishDocumentLoadTime: s + 1.18, finishLoadTime: s + 1.35, firstPaintTime: s + 0.9, firstPaintAfterLoadTime: 0, navigationType: "Other", wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: "h2", wasAlternateProtocolAvailable: false, connectionInfo: "h2" };
    }),
  });

  let timerId = 0;
  const timers = new Map();
  let frameClock = 0;
  let frameCount = 0;
  function timer(name, repeat) {
    return nfn(name, function (fn, ms) {
      const id = ++timerId;
      const extra = Array.prototype.slice.call(arguments, 2);
      log("timer", name, String(ms));
      const run = function () {
        try {
          if (typeof fn === "function") fn.apply(null, extra);
        } catch (e) {
          bridge.error("timer " + name, e);
        }
        if (!repeat) timers.delete(id);
      };
      timers.set(id, bridge.schedule(run, ms, repeat));
      return id;
    });
  }
  function clearer(name) {
    return nfn(name, function (id) {
      const h = timers.get(id);
      if (h) bridge.cancel(h);
      timers.delete(id);
    });
  }

  function XMLHttpRequest() {
    host(this);
    eventTarget(this, "xhr");
    this.readyState = 0;
    this.status = 0;
    this.responseText = "";
    this.response = "";
    this._headers = {};
  }
  host(XMLHttpRequest);
  nativeNames.set(XMLHttpRequest, "XMLHttpRequest");
  XMLHttpRequest.prototype.open = nfn("open", function (method, u, async) {
    this._method = method;
    this._url = String(u);
    this.readyState = 1;
  });
  XMLHttpRequest.prototype.setRequestHeader = nfn("setRequestHeader", function (k, v) {
    this._headers[k] = v;
  });
  XMLHttpRequest.prototype.getResponseHeader = nfn("getResponseHeader", function () {
    return null;
  });
  XMLHttpRequest.prototype.getAllResponseHeaders = nfn("getAllResponseHeaders", function () {
    return "";
  });
  XMLHttpRequest.prototype.abort = nfn("abort", function () {});
  XMLHttpRequest.prototype.send = nfn("send", function (bodyArg) {
    const self = this;
    const reply = bridge.capture({ method: this._method, url: this._url, headers: this._headers, body: bodyArg == null ? null : String(bodyArg) });
    if (reply == null) return;
    bridge.schedule(function () {
      self.readyState = 4;
      self.status = 200;
      self.responseText = reply;
      self.response = reply;
      try {
        if (typeof self.onreadystatechange === "function") self.onreadystatechange();
        if (typeof self.onload === "function") self.onload();
        listeners.filter((l) => l.owner === "xhr" && (l.type === "load" || l.type === "readystatechange")).forEach((l) => l.fn.call(self, host({ type: l.type, target: self })));
      } catch (e) {
        bridge.error("xhr callback", e);
      }
    }, 5, false);
  });

  function MutationObserver(cb) {
    host(this, "MutationObserver");
    this._cb = cb;
    this._targets = [];
  }
  host(MutationObserver);
  nativeNames.set(MutationObserver, "MutationObserver");
  MutationObserver.prototype.observe = nfn("observe", function (target) {
    const t = raw(target);
    if (t && t.__observers) {
      t.__observers.push(this);
      this._targets.push(t);
    }
  });
  MutationObserver.prototype.disconnect = nfn("disconnect", function () {
    const self = this;
    this._targets.forEach(function (t) {
      t.__observers = t.__observers.filter(function (o) {
        return o !== self;
      });
    });
    this._targets = [];
  });
  MutationObserver.prototype.takeRecords = nfn("takeRecords", function () {
    return host([]);
  });

  function TextEncoder() {
    host(this);
  }
  host(TextEncoder);
  nativeNames.set(TextEncoder, "TextEncoder");
  host(TextEncoder.prototype, "TextEncoder");
  getter(TextEncoder.prototype, "encoding", function () {
    return "utf-8";
  });
  method(TextEncoder.prototype, "encode", function (s) {
    return Uint8Array.from(JSON.parse(bridge.utf8Encode(String(s === undefined ? "" : s))));
  });

  function TextDecoder(label) {
    host(this);
    this._label = label || "utf-8";
  }
  host(TextDecoder);
  nativeNames.set(TextDecoder, "TextDecoder");
  host(TextDecoder.prototype, "TextDecoder");
  method(TextDecoder.prototype, "decode", function (buf) {
    const b = raw(buf);
    const u8 = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return bridge.utf8Decode(JSON.stringify(Array.from(u8)));
  });

  const fetch = nfn("fetch", function (input, init) {
    init = init || {};
    const reply = bridge.capture({
      via: "fetch",
      method: init.method || "GET",
      url: String(input && input.url ? input.url : input),
      headers: init.headers || {},
      body: init.body == null ? null : String(init.body),
    });
    return new Promise(function (resolve, reject) {
      if (reply == null) return;
      bridge.schedule(function () {
        resolve(
          host(
            {
              ok: true,
              status: 200,
              statusText: "OK",
              headers: host({ get: nfn("get", function () { return null; }) }, "Headers"),
              text: nfn("text", function () {
                return Promise.resolve(reply);
              }),
              json: nfn("json", function () {
                return Promise.resolve(JSON.parse(reply));
              }),
            },
            "Response"
          )
        );
      }, 5, false);
    });
  });

  host(location, "Location");

  Object.keys(tagClass).forEach(protoFor);
  protoFor("unknown-element");
  const warmCanvas = element("canvas");
  context2d(warmCanvas);
  webgl(warmCanvas, 1);
  webgl(warmCanvas, 2);
  st(warmCanvas).ops = [];

  getter(ifaces.File.prototype, "lastModified", function () {
    return st(this).lastModified || Date.now();
  });
  getter(ifaces.File.prototype, "name", function () {
    return String(st(this).name);
  });

  const urlProto = iface("URL", null, function (u, base) {
    const parsed = JSON.parse(bridge.parseUrl(String(u), base === undefined ? undefined : String(base)));
    if (parsed.error) throw new TypeError("Failed to construct 'URL': Invalid URL");
    return inst(urlProto, parsed);
  });
  ["href", "protocol", "host", "hostname", "port", "pathname", "search", "hash", "origin", "username", "password"].forEach(function (k) {
    getter(urlProto, k, function () {
      return st(this)[k] || "";
    });
  });
  getter(urlProto, "searchParams", function () {
    return host({ get: nfn("get", function () { return null; }) }, "URLSearchParams");
  });
  method(urlProto, "toString", function () {
    return st(this).href;
  });
  method(urlProto, "toJSON", function () {
    return st(this).href;
  });

  const visualViewportProto = iface("VisualViewport", eventTargetProto);
  getters(visualViewportProto, {
    width: (P.window && P.window.innerWidth) || 1920,
    height: (P.window && P.window.innerHeight) || 945,
    scale: 1,
    offsetLeft: 0,
    offsetTop: 0,
    pageLeft: 0,
    pageTop: 0,
    onresize: null,
    onscroll: null,
  });
  const visualViewport = inst(visualViewportProto, { label: "visualViewport" });

  const domImplProto = iface("DOMImplementation");
  method(domImplProto, "hasFeature", function () {
    return true;
  });
  method(domImplProto, "createHTMLDocument", function () {
    return inst(htmlDocumentProto, { label: "document2", children: [], parent: null });
  });
  const domImpl = inst(domImplProto);
  getter(documentProto, "implementation", function () {
    return domImpl;
  });
  const attrProto = iface("Attr", nodeProto);
  getters(attrProto, {
    name: function () {
      return st(this).name;
    },
    value: function () {
      return st(this).value || "";
    },
  });
  method(documentProto, "createAttribute", function (n) {
    return inst(attrProto, { name: String(n).toLowerCase(), value: "" });
  });

  const winTarget = eventTarget(host({}, "Window"), "window");
  Object.assign(winTarget, ifaces);
  Object.assign(winTarget, P.window, {
    chrome: chromeObj,
    external,
    indexedDB,
    navigation: navigationApi,
    visualViewport,
    PERSISTENT: 1,
    TEMPORARY: 0,
    onload: null,
    onerror: null,
    onmessage: null,
    devicePixelRatio: (P.window && P.window.devicePixelRatio) || 1,
    queueMicrotask: nfn("queueMicrotask", function (fn) {
      Promise.resolve().then(fn);
    }),
    structuredClone: nfn("structuredClone", function (v) {
      return JSON.parse(JSON.stringify(v));
    }),
    document,
    navigator,
    location,
    screen,
    performance,
    XMLHttpRequest,
    MutationObserver,
    TextEncoder,
    TextDecoder,
    fetch,
    name: "",
    closed: false,
    length: 0,
    opener: null,
    frameElement: null,
    isSecureContext: true,
    origin: url.origin,
    history: host({ length: 2 }),
    localStorage: host({}),
    sessionStorage: host({}),
    atob: nfn("atob", function (s) {
      return bridge.atob(String(s));
    }),
    btoa: nfn("btoa", function (s) {
      return bridge.btoa(String(s));
    }),
    setTimeout: timer("setTimeout", false),
    setInterval: timer("setInterval", true),
    clearTimeout: clearer("clearTimeout"),
    clearInterval: clearer("clearInterval"),
    requestAnimationFrame: nfn("requestAnimationFrame", function (fn) {
      const id = ++timerId;
      const period = 1000 / 60;
      const nowMs = bridge.now();
      if (frameClock === 0 || nowMs - frameClock > period * 4) frameClock = nowMs;
      let target = frameClock + period;
      while (target <= nowMs) target += period;
      const jitter = ((frameCount * 37) % 11) * 0.004;
      const stamp = Math.round((target + jitter) * 1000) / 1000;
      const run = function () {
        frameClock = target;
        frameCount++;
        try {
          if (typeof fn === "function") fn(stamp);
        } catch (e) {
          bridge.error("requestAnimationFrame", e);
        }
        timers.delete(id);
      };
      log("timer", "requestAnimationFrame", String(Math.round(target - nowMs)));
      timers.set(id, bridge.schedule(run, Math.max(0, target - nowMs), false));
      return id;
    }),
    cancelAnimationFrame: clearer("cancelAnimationFrame"),
    requestIdleCallback: nfn("requestIdleCallback", function (fn) {
      const id = ++timerId;
      const run = function () {
        try {
          if (typeof fn === "function")
            fn(
              host(
                {
                  didTimeout: false,
                  timeRemaining: nfn("timeRemaining", function () {
                    return Math.round(Math.max(0, 49.5 - (frameCount % 9) * 1.3) * 1000) / 1000;
                  }),
                },
                "IdleDeadline"
              )
            );
        } catch (e) {
          bridge.error("requestIdleCallback", e);
        }
        timers.delete(id);
      };
      timers.set(id, bridge.schedule(run, 1 + (frameCount % 3), false));
      return id;
    }),
    cancelIdleCallback: clearer("cancelIdleCallback"),
    getComputedStyle: nfn("getComputedStyle", function () {
      return host({ getPropertyValue: nfn("getPropertyValue", function () { return ""; }) });
    }),
    matchMedia: nfn("matchMedia", function (q) {
      return host({ matches: false, media: q });
    }),
  });
  const win = wrap(winTarget, "window");
  winTarget.window = winTarget;
  winTarget.self = winTarget;
  winTarget.top = winTarget;
  winTarget.parent = winTarget;
  winTarget.globalThis = winTarget;
  winTarget.frames = winTarget;

  G.window = win;
  G.self = win;
  G.document = wrap(document, "window.document");
  G.navigator = wrap(navigator, "window.navigator");
  G.location = wrap(location, "window.location");
  G.screen = wrap(screen, "window.screen");
  G.performance = wrap(performance, "window.performance");
  function stubFor(name, type, flags, len, tag) {
    if (type === "function") {
      const f = function () {};
      try {
        Object.defineProperty(f, "name", { value: tag || name, configurable: true });
        Object.defineProperty(f, "length", { value: len | 0, configurable: true });
      } catch (e) {}
      nativeNames.set(f, tag || name);
      const proto = {};
      Object.defineProperty(proto, "constructor", { value: f, writable: true, configurable: true });
      Object.defineProperty(f, "prototype", { value: host(proto, tag || name), writable: false, configurable: false });
      return host(f);
    }
    if (type === "object") return host({}, tag || undefined);
    if (type === "number") return Number(tag);
    if (type === "boolean") return tag === "true";
    if (type === "string") return String(tag);
    if (type === "null") return null;
    return undefined;
  }

  const hasOwnRef = Object.prototype.hasOwnProperty;
  function applyKeyShape(target, shape) {
    if (!shape || !shape.length) return;
    if (target === Object.prototype || target === Function.prototype || target === Array.prototype) return;
    const saved = new Map();
    for (const name of Object.getOwnPropertyNames(target)) {
      const d = Object.getOwnPropertyDescriptor(target, name);
      if (!d || !d.configurable) continue;
      saved.set(name, d);
      try {
        delete target[name];
      } catch (e) {}
    }
    for (const entry of shape) {
      const name = entry[0];
      const type = entry[1];
      const flags = entry[2] || "";
      if (hasOwnRef.call(target, name)) continue;
      const had = saved.get(name);
      if (had) {
        try {
          const fixed = { enumerable: flags.indexOf("e") >= 0, configurable: flags.indexOf("c") >= 0 };
          if (had.get || had.set) {
            fixed.get = had.get;
            fixed.set = had.set;
          } else {
            fixed.value = had.value;
            fixed.writable = flags.indexOf("w") >= 0;
            if (!fixed.writable && !fixed.configurable && fixed.value !== null && (typeof fixed.value === "object" || typeof fixed.value === "function")) {
              fixed.value = wrap(fixed.value, "window." + name);
            }
          }
          Object.defineProperty(target, name, fixed);
        } catch (e) {
          try {
            Object.defineProperty(target, name, had);
          } catch (e2) {}
        }
        saved.delete(name);
        continue;
      }
      const enumerable = flags.indexOf("e") >= 0;
      const configurable = flags.indexOf("c") >= 0;
      try {
        if (type === "accessor") {
          const hint = String(entry[4] || "");
          const sep = hint.indexOf(":");
          const kind = sep >= 0 ? hint.slice(0, sep) : "";
          const tag = sep >= 0 ? hint.slice(sep + 1) : "";
          let cached;
          let made = false;
          Object.defineProperty(target, name, {
            get: nfn("get " + name, function () {
              if (!made) {
                made = true;
                if (kind === "object" && tag) cached = host({}, tag);
                else if (kind === "function" && tag) cached = nfn(tag, function () {});
                else if (kind === "boolean") cached = tag === "true";
                else if (kind === "number") cached = Number(tag);
                else if (kind === "string") cached = tag;
                else if (kind === "null") cached = null;
                else cached = undefined;
              }
              if (kind === "throws") throw new TypeError("Illegal invocation");
              return cached;
            }),
            set: flags.indexOf("s") >= 0 ? nfn("set " + name, function () {}) : undefined,
            enumerable: enumerable,
            configurable: configurable,
          });
          continue;
        }
        let value = intrinsics.has(name) && target === winTarget ? G[name] : undefined;
        if (value === undefined) value = stubFor(name, type, flags, entry[3], entry[4]);
        Object.defineProperty(target, name, {
          value: value,
          writable: flags.indexOf("w") >= 0,
          enumerable: enumerable,
          configurable: configurable,
        });
      } catch (e) {}
    }
    const shapeNames = new Set(shape.map(function (e) { return e[0]; }));
    for (const [name, d] of saved.entries()) {
      if (hasOwnRef.call(target, name)) continue;
      if (target === winTarget && !shapeNames.has(name)) continue;
      try {
        Object.defineProperty(target, name, d);
      } catch (e) {}
    }
  }


  function b64ToBytes(b64) {
    const bin = bridge.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(view) {
    let s = "";
    const u = view instanceof Uint8Array ? view : new Uint8Array(view.buffer || view);
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return bridge.btoa(s);
  }

  function viewBytes(data) {
    const t = raw(data);
    if (t == null) return new Uint8Array(0);
    if (t instanceof ArrayBuffer) return new Uint8Array(t);
    if (ArrayBuffer.isView(t)) return new Uint8Array(t.buffer, t.byteOffset, t.byteLength);
    if (typeof t === "string") {
      const enc = new TextEncoderImpl();
      return enc.encode(t);
    }
    return new Uint8Array(0);
  }

  function TextEncoderImpl() {}
  TextEncoderImpl.prototype.encode = function (input) {
    const arr = JSON.parse(bridge.utf8Encode(String(input === undefined ? "" : input)));
    const out = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i];
    return out;
  };
  Object.defineProperty(TextEncoderImpl.prototype, "encoding", { get: function () { return "utf-8"; } });

  const textEncoderProto = iface("TextEncoder");
  method(textEncoderProto, "encode", function (input) {
    const arr = JSON.parse(bridge.utf8Encode(String(input === undefined ? "" : input)));
    const out = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i];
    return out;
  });
  method(textEncoderProto, "encodeInto", function (input, dest) {
    const bytes = JSON.parse(bridge.utf8Encode(String(input === undefined ? "" : input)));
    const target = raw(dest);
    const n = Math.min(bytes.length, target.length);
    for (let i = 0; i < n; i++) target[i] = bytes[i];
    return host({ read: n, written: n });
  });
  getter(textEncoderProto, "encoding", function () {
    return "utf-8";
  });
  const TextEncoderCtor = nfn("TextEncoder", function () {
    return inst(textEncoderProto, {});
  });
  TextEncoderCtor.prototype = textEncoderProto;

  const textDecoderProto = iface("TextDecoder");
  method(textDecoderProto, "decode", function (data) {
    const bytes = viewBytes(data);
    return bridge.utf8Decode(JSON.stringify(Array.prototype.slice.call(bytes)));
  });
  getter(textDecoderProto, "encoding", function () {
    return "utf-8";
  });
  const TextDecoderCtor = nfn("TextDecoder", function () {
    return inst(textDecoderProto, {});
  });
  TextDecoderCtor.prototype = textDecoderProto;

  const cryptoKeyProto = iface("CryptoKey");
  getters(cryptoKeyProto, {
    type: function () {
      return st(this).type;
    },
    extractable: function () {
      return st(this).extractable;
    },
    algorithm: function () {
      return st(this).algorithm;
    },
    usages: function () {
      return st(this).usages;
    },
  });

  function subtleCall(op, args, data, key) {
    return new Promise(function (resolve, reject) {
      let payload;
      try {
        payload = JSON.stringify({
          op: op,
          args: args,
          data: data === undefined ? null : bytesToB64(viewBytes(data)),
          key: key === undefined || key === null ? null : st(raw(key)).handle,
        });
      } catch (e) {
        reject(new TypeError(String(e && e.message)));
        return;
      }
      bridge.subtle(payload, function (err, resultJson) {
        if (err) {
          reject(new Error(String(err)));
          return;
        }
        let out;
        try {
          out = JSON.parse(resultJson);
        } catch (e) {
          reject(new Error("bad subtle result"));
          return;
        }
        if (out.kind === "bytes") {
          const bytes = b64ToBytes(out.value);
          resolve(bytes.buffer);
          return;
        }
        if (out.kind === "key") {
          resolve(inst(cryptoKeyProto, { handle: out.handle, type: out.type, extractable: out.extractable, algorithm: out.algorithm, usages: out.usages }));
          return;
        }
        if (out.kind === "keypair") {
          resolve(
            host({
              publicKey: inst(cryptoKeyProto, { handle: out.publicKey.handle, type: out.publicKey.type, extractable: out.publicKey.extractable, algorithm: out.publicKey.algorithm, usages: out.publicKey.usages }),
              privateKey: inst(cryptoKeyProto, { handle: out.privateKey.handle, type: out.privateKey.type, extractable: out.privateKey.extractable, algorithm: out.privateKey.algorithm, usages: out.privateKey.usages }),
            })
          );
          return;
        }
        if (out.kind === "json") {
          resolve(out.value);
          return;
        }
        if (out.kind === "boolean") {
          resolve(!!out.value);
          return;
        }
        resolve(undefined);
      });
    });
  }

  const subtleProto = iface("SubtleCrypto");
  method(subtleProto, "digest", function (alg, data) {
    return subtleCall("digest", { alg: raw(alg) }, data);
  });
  method(subtleProto, "encrypt", function (alg, key, data) {
    return subtleCall("encrypt", { alg: normAlg(alg) }, data, key);
  });
  method(subtleProto, "decrypt", function (alg, key, data) {
    return subtleCall("decrypt", { alg: normAlg(alg) }, data, key);
  });
  method(subtleProto, "sign", function (alg, key, data) {
    return subtleCall("sign", { alg: normAlg(alg) }, data, key);
  });
  method(subtleProto, "verify", function (alg, key, sig, data) {
    return subtleCall("verify", { alg: normAlg(alg), sig: bytesToB64(viewBytes(sig)) }, data, key);
  });
  method(subtleProto, "importKey", function (format, keyData, alg, extractable, usages) {
    const isJwk = String(format) === "jwk";
    return subtleCall(
      "importKey",
      {
        format: String(format),
        alg: normAlg(alg),
        extractable: !!extractable,
        usages: Array.prototype.slice.call(raw(usages) || []),
        jwk: isJwk ? JSON.parse(JSON.stringify(raw(keyData))) : null,
      },
      isJwk ? undefined : keyData
    );
  });
  method(subtleProto, "exportKey", function (format, key) {
    return subtleCall("exportKey", { format: String(format) }, undefined, key);
  });
  method(subtleProto, "generateKey", function (alg, extractable, usages) {
    return subtleCall("generateKey", { alg: normAlg(alg), extractable: !!extractable, usages: Array.prototype.slice.call(raw(usages) || []) });
  });
  method(subtleProto, "deriveBits", function (alg, key, length) {
    return subtleCall("deriveBits", { alg: normAlg(alg), length: length }, undefined, key);
  });
  method(subtleProto, "deriveKey", function (alg, key, derived, extractable, usages) {
    return subtleCall("deriveKey", { alg: normAlg(alg), derived: normAlg(derived), extractable: !!extractable, usages: Array.prototype.slice.call(raw(usages) || []) }, undefined, key);
  });

  function normAlg(alg) {
    const a = raw(alg);
    if (a == null) return null;
    if (typeof a === "string") return a;
    const out = {};
    for (const k of Object.keys(a)) {
      const v = a[k];
      if (v == null) {
        out[k] = v;
        continue;
      }
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
        out[k] = { __bytes: bytesToB64(viewBytes(v)) };
        continue;
      }
      if (typeof v === "object") {
        out[k] = normAlg(v);
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  const subtle = inst(subtleProto, {});

  const cryptoProto = iface("Crypto");
  method(cryptoProto, "getRandomValues", function (arr) {
    const target = raw(arr);
    const bytes = b64ToBytes(bridge.randomBytes(target.byteLength || target.length));
    const view = new Uint8Array(target.buffer ? target.buffer : target, target.byteOffset || 0, target.byteLength || target.length);
    for (let i = 0; i < view.length; i++) view[i] = bytes[i];
    return arr;
  });
  method(cryptoProto, "randomUUID", function () {
    return bridge.randomUUID();
  });
  getter(cryptoProto, "subtle", function () {
    return subtle;
  });
  const cryptoObj = inst(cryptoProto, {});

  win.crypto = cryptoObj;
  win.TextEncoder = TextEncoderCtor;
  win.TextDecoder = TextDecoderCtor;
  win.queueMicrotask = nfn("queueMicrotask", function (fn) {
    Promise.resolve().then(function () {
      try {
        fn();
      } catch (e) {
        bridge.error("queueMicrotask", e);
      }
    });
  });
  G.crypto = cryptoObj;
  G.TextEncoder = TextEncoderCtor;
  G.TextDecoder = TextDecoderCtor;
  G.queueMicrotask = win.queueMicrotask;

  const keyShapes = P.keys || {};
  applyKeyShape(winTarget, (keyShapes["window"] || {}).shape);
  applyKeyShape(navigatorProto, (keyShapes["window.navigator.__proto__"] || {}).shape);

  (function () {
    function define(target, name, value) {
      try {
        Object.defineProperty(raw(target), name, { value: value, writable: true, enumerable: true, configurable: true });
      } catch (e) {}
    }
    function tagged(tag, extra) {
      return host(Object.assign({}, extra || {}), tag);
    }

    const barProto = iface("BarProp");
    getter(barProto, "visible", function () {
      return true;
    });
    ["menubar", "locationbar", "personalbar", "scrollbars", "statusbar", "toolbar"].forEach(function (n) {
      define(win, n, inst(barProto, {}));
    });

    const storageProto = iface("Storage");
    method(storageProto, "getItem", function (k) {
      const data = st(this).data;
      return Object.prototype.hasOwnProperty.call(data, String(k)) ? data[String(k)] : null;
    });
    method(storageProto, "setItem", function (k, v) {
      st(this).data[String(k)] = String(v);
    });
    method(storageProto, "removeItem", function (k) {
      delete st(this).data[String(k)];
    });
    method(storageProto, "clear", function () {
      const data = st(this).data;
      for (const k of Object.keys(data)) delete data[k];
    });
    method(storageProto, "key", function (i) {
      const keys = Object.keys(st(this).data);
      return i < keys.length ? keys[i] : null;
    });
    getter(storageProto, "length", function () {
      return Object.keys(st(this).data).length;
    });
    function makeStorage(initial) {
      return inst(storageProto, { data: Object.assign({}, initial || {}) });
    }
    define(win, "localStorage", makeStorage(P.localStorage));
    define(win, "sessionStorage", makeStorage(P.sessionStorage));

    const mqlProto = iface("MediaQueryList", eventTargetProto);
    getters(mqlProto, {
      media: function () {
        return st(this).media;
      },
      matches: function () {
        return st(this).matches;
      },
    });
    method(mqlProto, "addListener", function () {});
    method(mqlProto, "removeListener", function () {});
    const mediaAnswers = P.mediaQueries || {};
    const computedSample = P.computedStyle || {};
    define(win, "matchMedia", nfn("matchMedia", function (q) {
      const key = String(q);
      let matches = mediaAnswers[key];
      if (matches === undefined) {
        if (/prefers-color-scheme:\s*light/.test(key)) matches = true;
        else if (/prefers-color-scheme:\s*dark/.test(key)) matches = false;
        else if (/hover:\s*hover/.test(key)) matches = true;
        else if (/pointer:\s*fine/.test(key)) matches = true;
        else if (/prefers-reduced-motion:\s*reduce/.test(key)) matches = false;
        else matches = false;
      }
      return inst(mqlProto, { media: key, matches: !!matches });
    }));

    const CSS_DEFAULTS = {
      opacity: "1",
      visibility: "visible",
      position: "static",
      transform: "none",
      filter: "none",
      mixBlendMode: "normal",
      perspective: "none",
      fontStretch: "100%",
      fontWeight: "400",
      fontStyle: "normal",
      textRendering: "auto",
      webkitFontSmoothing: "auto",
      width: "auto",
      height: "auto",
      overflow: "visible",
      boxSizing: "content-box",
      float: "none",
      clear: "none",
      whiteSpace: "normal",
      wordSpacing: "0px",
      letterSpacing: "normal",
      textTransform: "none",
      textDecoration: "none solid rgb(0, 0, 0)",
      borderStyle: "none",
      borderWidth: "0px",
      margin: "0px",
      padding: "0px",
    };
    const cssStyleProto = iface("CSSStyleDeclaration");
    const computed = Object.assign({}, CSS_DEFAULTS, computedSample);
    delete computed.length;
    method(cssStyleProto, "getPropertyValue", function (k) {
      return computed[String(k)] || "";
    });
    getter(cssStyleProto, "length", function () {
      return Object.keys(computed).length;
    });
    const computedInst = inst(cssStyleProto, {});
    Object.keys(computed).forEach(function (k) {
      try {
        Object.defineProperty(raw(computedInst), k, { value: computed[k], enumerable: true, configurable: true });
      } catch (e) {}
    });
    define(win, "getComputedStyle", nfn("getComputedStyle", function () {
      return computedInst;
    }));

    const notificationCtor = nfn("Notification", function () {
      return host({}, "Notification");
    });
    Object.defineProperty(notificationCtor, "permission", {
      get: nfn("get permission", function () {
        return P.notificationPermission || "default";
      }),
      configurable: true,
    });
    method(notificationCtor, "requestPermission", function () {
      return resolved(P.notificationPermission || "default");
    });
    define(win, "Notification", notificationCtor);
    try {
      Object.defineProperty(win, "Notification", { enumerable: false });
    } catch (e) {}

    const DEFAULT_VOICES = [
      { voiceURI: "Microsoft George - English (United Kingdom)", name: "Microsoft George - English (United Kingdom)", lang: "en-GB", localService: true, default: true },
      { voiceURI: "Microsoft Hazel - English (United Kingdom)", name: "Microsoft Hazel - English (United Kingdom)", lang: "en-GB", localService: true, default: false },
      { voiceURI: "Microsoft Susan - English (United Kingdom)", name: "Microsoft Susan - English (United Kingdom)", lang: "en-GB", localService: true, default: false },
      { voiceURI: "Google Deutsch", name: "Google Deutsch", lang: "de-DE", localService: false, default: false },
      { voiceURI: "Google US English", name: "Google US English", lang: "en-US", localService: false, default: false },
      { voiceURI: "Google UK English Female", name: "Google UK English Female", lang: "en-GB", localService: false, default: false },
      { voiceURI: "Google UK English Male", name: "Google UK English Male", lang: "en-GB", localService: false, default: false },
      { voiceURI: "Google español", name: "Google español", lang: "es-ES", localService: false, default: false },
      { voiceURI: "Google español de Estados Unidos", name: "Google español de Estados Unidos", lang: "es-US", localService: false, default: false },
      { voiceURI: "Google français", name: "Google français", lang: "fr-FR", localService: false, default: false },
      { voiceURI: "Google हिन्दी", name: "Google हिन्दी", lang: "hi-IN", localService: false, default: false },
      { voiceURI: "Google Bahasa Indonesia", name: "Google Bahasa Indonesia", lang: "id-ID", localService: false, default: false },
      { voiceURI: "Google italiano", name: "Google italiano", lang: "it-IT", localService: false, default: false },
      { voiceURI: "Google 日本語", name: "Google 日本語", lang: "ja-JP", localService: false, default: false },
      { voiceURI: "Google 한국의", name: "Google 한국의", lang: "ko-KR", localService: false, default: false },
      { voiceURI: "Google Nederlands", name: "Google Nederlands", lang: "nl-NL", localService: false, default: false },
      { voiceURI: "Google polski", name: "Google polski", lang: "pl-PL", localService: false, default: false },
      { voiceURI: "Google português do Brasil", name: "Google português do Brasil", lang: "pt-BR", localService: false, default: false },
      { voiceURI: "Google русский", name: "Google русский", lang: "ru-RU", localService: false, default: false },
      { voiceURI: "Google 普通话（中国大陆）", name: "Google 普通话（中国大陆）", lang: "zh-CN", localService: false, default: false },
      { voiceURI: "Google 粤語（香港）", name: "Google 粤語（香港）", lang: "zh-HK", localService: false, default: false },
      { voiceURI: "Google 國語（臺灣）", name: "Google 國語（臺灣）", lang: "zh-TW", localService: false, default: false },
    ];
    const voiceProto = iface("SpeechSynthesisVoice");
    getters(voiceProto, {
      voiceURI: function () { return st(this).voiceURI; },
      name: function () { return st(this).name; },
      lang: function () { return st(this).lang; },
      localService: function () { return st(this).localService; },
      default: function () { return st(this).isDefault; },
    });
    let voiceList = null;
    function buildVoices() {
      if (voiceList) return voiceList;
      const src = Array.isArray(P.voices) ? P.voices : [];
      const made = src.map(function (v) {
        return inst(voiceProto, {
          voiceURI: String(v.voiceURI === undefined ? v.name : v.voiceURI),
          name: String(v.name || ""),
          lang: String(v.lang || ""),
          localService: !!v.localService,
          isDefault: !!(v.default || v.isDefault),
        });
      });
      voiceList = host(made, "Array");
      return voiceList;
    }
    const speechProto = iface("SpeechSynthesis", eventTargetProto);
    method(speechProto, "getVoices", function () {
      return buildVoices();
    });
    method(speechProto, "speak", function () {});
    method(speechProto, "cancel", function () {});
    define(win, "speechSynthesis", inst(speechProto, {}));

    define(win, "caches", tagged("CacheStorage"));

    const historyProto = iface("History");
    getters(historyProto, {
      length: function () {
        return P.historyLength === undefined ? 2 : P.historyLength;
      },
      scrollRestoration: function () {
        return "auto";
      },
      state: function () {
        return null;
      },
    });
    ["pushState", "replaceState", "go", "back", "forward"].forEach(function (n) {
      method(historyProto, n, function () {});
    });
    define(win, "history", inst(historyProto, {}));

    define(win, "pageXOffset", 0);
    define(win, "pageYOffset", 0);
    define(win, "crossOriginIsolated", false);
    define(win, "originAgentCluster", true);
    try {
      delete winTarget.SharedArrayBuffer;
      delete G.SharedArrayBuffer;
    } catch (e) {}
    win.top = win;
    win.parent = win;
    win.self = win;
    win.frames = win;
    win.window = win;
  })();

  G.XMLHttpRequest = wrap(XMLHttpRequest, "window.XMLHttpRequest");
  G.setTimeout = winTarget.setTimeout;
  G.setInterval = winTarget.setInterval;
  G.clearTimeout = winTarget.clearTimeout;
  G.clearInterval = winTarget.clearInterval;
  G.atob = winTarget.atob;
  G.btoa = winTarget.btoa;

  (function mirrorGlobals() {
    const skip = new Set(["globalThis", "window", "self", "top", "parent", "frames", "eval", "arguments", "undefined", "NaN", "Infinity"]);
    for (const name of Object.getOwnPropertyNames(winTarget)) {
      if (skip.has(name)) continue;
      if (Object.prototype.hasOwnProperty.call(G, name)) continue;
      const d = Object.getOwnPropertyDescriptor(winTarget, name);
      if (!d) continue;
      try {
        Object.defineProperty(G, name, {
          get: function () {
            return win[name];
          },
          set: function (v) {
            win[name] = v;
          },
          enumerable: !!d.enumerable,
          configurable: true,
        });
      } catch (e) {}
    }
    for (const name of ["window", "self", "top", "parent", "frames"]) {
      try {
        Object.defineProperty(G, name, { value: win, writable: true, enumerable: false, configurable: true });
      } catch (e) {}
    }
  })();

  (function documentSurface() {
    const stats = (P.dom && P.dom.stats) || {};
    const ds = st(document);
    ds.title = stats.title || "";

    function collection(n, tag) {
      const items = [];
      for (let i = 0; i < (n | 0); i++) items.push(raw(element(tag)));
      return host(items, "HTMLCollection");
    }

    getters(htmlDocumentProto, {
      title: function () {
        return st(this).title || "";
      },
      dir: function () {
        return "";
      },
      designMode: function () {
        return "off";
      },
      currentScript: function () {
        return null;
      },
      doctype: function () {
        return host({ name: "html", publicId: "", systemId: "", nodeType: 10, nodeName: "html" }, "DocumentType");
      },
      scripts: function () {
        return collection(stats.scripts, "script");
      },
      images: function () {
        return collection(stats.images, "img");
      },
      links: function () {
        return collection(stats.links, "a");
      },
      forms: function () {
        return collection(stats.forms, "form");
      },
      embeds: function () {
        return collection(0, "embed");
      },
      plugins: function () {
        return collection(0, "embed");
      },
      styleSheets: function () {
        const items = [];
        for (let i = 0; i < (stats.styleSheets | 0); i++) items.push(host({ disabled: false, href: null, title: null, type: "text/css" }, "CSSStyleSheet"));
        return host(items, "StyleSheetList");
      },
      all: function () {
        return collection(stats.all, "div");
      },
      fonts: function () {
        return host({ size: 0, status: "loaded", ready: resolved(undefined) }, "FontFaceSet");
      },
    });

    method(elementProto, "remove", function () {
      const s = st(this);
      if (s.parent) {
        const kids = st(s.parent).children;
        const i = kids.indexOf(raw(this));
        if (i >= 0) kids.splice(i, 1);
        s.parent = null;
      }
    });

    const nav = P.navigationTiming || {};
    function scriptResource() {
      const url = String(P.scriptUrl || "");
      if (!url) return null;
      const t0 = Number(nav.responseEnd || 44) + 4.3;
      return {
        name: url,
        entryType: "resource",
        startTime: Math.round(t0 * 10) / 10,
        duration: 171.8,
        initiatorType: "script",
        deliveryType: "",
        nextHopProtocol: "h2",
        renderBlockingStatus: "blocking",
        contentType: "text/javascript",
        contentEncoding: "br",
        workerStart: 0,
        workerRouterEvaluationStart: 0,
        workerCacheLookupStart: 0,
        workerMatchedSourceType: "",
        workerFinalSourceType: "",
        redirectStart: 0,
        redirectEnd: 0,
        fetchStart: Math.round(t0 * 10) / 10,
        domainLookupStart: Math.round(t0 * 10) / 10,
        domainLookupEnd: Math.round(t0 * 10) / 10,
        connectStart: Math.round(t0 * 10) / 10,
        secureConnectionStart: 0,
        connectEnd: Math.round(t0 * 10) / 10,
        requestStart: Math.round((t0 + 1.7) * 10) / 10,
        responseStart: Math.round((t0 + 94.4) * 10) / 10,
        firstInterimResponseStart: 0,
        finalResponseHeadersStart: Math.round((t0 + 94.4) * 10) / 10,
        responseEnd: Math.round((t0 + 171.8) * 10) / 10,
        transferSize: 219604,
        encodedBodySize: 219304,
        decodedBodySize: 837153,
        responseStatus: 200,
        renderBlockingStatus2: undefined,
        serverTiming: [],
      };
    }
    function paintEntries() {
      const base = Number(nav.domContentLoadedEventEnd || 60);
      return [
        { name: "first-paint", entryType: "paint", startTime: Math.round((base + 142.6) * 10) / 10, duration: 0 },
        { name: "first-contentful-paint", entryType: "paint", startTime: Math.round((base + 142.6) * 10) / 10, duration: 0 },
      ];
    }
    let resources = P.resourceEntries;
    if (!Array.isArray(resources) || !resources.length) {
      const r = scriptResource();
      resources = r ? [r] : [];
    }
    const paints = Array.isArray(P.paintEntries) ? P.paintEntries : paintEntries();
    method(performanceProto, "getEntriesByType", function (t) {
      const kind = String(t);
      if (kind === "navigation") return host([host(Object.assign({ entryType: "navigation", name: P.pageUrl || "", type: "navigate", startTime: 0 }, nav), "PerformanceNavigationTiming")], "Array");
      if (kind === "paint")
        return host(
          paints.map(function (p0) {
            return host(Object.assign({}, p0), "PerformancePaintTiming");
          }),
          "Array"
        );
      if (kind === "resource")
        return host(
          resources.map(function (r) {
            return host(Object.assign({ entryType: "resource", initiatorType: "script", startTime: 0, duration: 0 }, r), "PerformanceResourceTiming");
          }),
          "Array"
        );
      return host([], "Array");
    });
    method(performanceProto, "getEntries", function () {
      const out = [];
      out.push(host(Object.assign({ entryType: "navigation", name: P.pageUrl || "", type: "navigate" }, nav), "PerformanceNavigationTiming"));
      paints.forEach(function (p0) {
        out.push(host(Object.assign({}, p0), "PerformancePaintTiming"));
      });
      resources.forEach(function (r) {
        out.push(host(Object.assign({ entryType: "resource", initiatorType: "script" }, r), "PerformanceResourceTiming"));
      });
      return host(out, "Array");
    });
  })();

  (function finalFidelity() {
    const windowProps = Object.create(eventTargetProto);
    try {
      Object.defineProperty(windowProps, Symbol.toStringTag, { value: "WindowProperties", configurable: true });
    } catch (e) {}
    const winProto = Object.create(windowProps);
    const WindowCtor = nfn("Window", function () {});
    Object.defineProperty(WindowCtor, "prototype", { value: winProto, writable: false, configurable: false });
    Object.defineProperty(winProto, "constructor", { value: WindowCtor, writable: true, enumerable: false, configurable: true });
    Object.defineProperty(winProto, Symbol.toStringTag, { value: "Window", configurable: true });
    try {
      Object.setPrototypeOf(winTarget, winProto);
    } catch (e) {}
    try {
      for (const s of Object.getOwnPropertySymbols(winTarget)) delete winTarget[s];
    } catch (e) {}

    const docProto = Object.getPrototypeOf(raw(document));
    if (docProto) {
      const DocCtor = nfn("HTMLDocument", function () {});
      try {
        Object.defineProperty(DocCtor, "prototype", { value: docProto, writable: false, configurable: false });
        Object.defineProperty(docProto, "constructor", { value: DocCtor, writable: true, enumerable: false, configurable: true });
      } catch (e) {}
    }

    const conn = P.connection || {};
    const connProto = iface("NetworkInformation", eventTargetProto);
    getters(connProto, {
      effectiveType: function () {
        return conn.effectiveType === undefined ? "4g" : conn.effectiveType;
      },
      rtt: function () {
        return conn.rtt === undefined ? 50 : conn.rtt;
      },
      downlink: function () {
        return conn.downlink === undefined ? 10 : conn.downlink;
      },
      saveData: function () {
        return !!conn.saveData;
      },
      type: function () {
        return conn.type === undefined ? undefined : conn.type;
      },
    });
    const connInst = inst(connProto, {});
    try {
      Object.defineProperty(navigatorProto, "connection", {
        get: nfn("get connection", function () {
          return connInst;
        }),
        enumerable: true,
        configurable: true,
      });
    } catch (e) {}

    const mem = P.memory || {};
    try {
      Object.defineProperty(performanceProto, "memory", {
        get: nfn("get memory", function () {
          return host(
            {
              jsHeapSizeLimit: mem.jsHeapSizeLimit === undefined ? 4294705152 : mem.jsHeapSizeLimit,
              totalJSHeapSize: mem.totalJSHeapSize === undefined ? 12000000 : mem.totalJSHeapSize,
              usedJSHeapSize: mem.usedJSHeapSize === undefined ? 9000000 : mem.usedJSHeapSize,
            },
            "MemoryInfo"
          );
        }),
        enumerable: true,
        configurable: true,
      });
    } catch (e) {}

    const chromeKeys = P.chrome && P.chrome.keys ? P.chrome.keys : ["loadTimes", "csi", "app"];
    const existing = raw(win.chrome);
    if (existing) {
      const saved = {};
      for (const k of chromeKeys) if (k in existing) saved[k] = existing[k];
      for (const k of Object.keys(existing)) delete existing[k];
      for (const k of chromeKeys) if (k in saved) existing[k] = saved[k];
    }

    method(elementProto, "getBoundingClientRect", function () {
      const s = st(this);
      const style = s.style ? raw(s.style) : {};
      const w = parseFloat(String(style.width || "0")) || 0;
      const h = parseFloat(String(style.height || "0")) || 0;
      return host({ x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON: nfn("toJSON", function () {}) }, "DOMRect");
    });

    const pageUrl = String(P.pageUrl || "");
    const stackUrl = String(P.scriptUrl || P.pageUrl || "");
    try {
      Error.stackTraceLimit = 10;
      Error.prepareStackTrace = undefined;
    } catch (e) {}
    const errProto = Error.prototype;
    const stackDesc = Object.getOwnPropertyDescriptor(errProto, "stack");
    void stackDesc;
    const origCapture = Error.captureStackTrace;
    if (typeof origCapture === "function") {
      Error.captureStackTrace = nfn("captureStackTrace", function (target) {
        origCapture.call(Error, target);
        rewriteStack(target);
      });
    }
    function rewriteStack(err) {
      try {
        const raw0 = err.stack;
        if (typeof raw0 !== "string") return;
        const lines = raw0.split("\n");
        const head = lines[0];
        const frames = lines
          .slice(1)
          .filter(function (l) {
            return !/env\.js|node:|vm\.js|runner\.js|probe\.js|recipe\.js/.test(l);
          })
          .slice(0, 10);
        while (frames.length < 10) frames.push("    at " + stackUrl + ":1:" + (676792 + ((frames.length * 1013) % 7211)));
        err.stack = [head].concat(frames).join("\n");
      } catch (e) {}
    }
    const RealError = Error;
    const errorNames = ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"];
    errorNames.forEach(function (name) {
      const Orig = G[name];
      if (typeof Orig !== "function") return;
      const Wrapped = function (message) {
        const e = new Orig(message);
        rewriteStack(e);
        return e;
      };
      Wrapped.prototype = Orig.prototype;
      nativeNames.set(Wrapped, name);
      try {
        Object.defineProperty(Wrapped, "name", { value: name, configurable: true });
        Object.defineProperty(Wrapped, "length", { value: Orig.length, configurable: true });
      } catch (e) {}
      try {
        Object.defineProperty(winTarget, name, { value: Wrapped, writable: true, enumerable: false, configurable: true });
        Object.defineProperty(G, name, { value: Wrapped, writable: true, enumerable: false, configurable: true });
      } catch (e) {}
    });
    try {
      Object.defineProperty(Error.captureStackTrace, "length", { value: 2, configurable: true });
    } catch (e) {}
    try {
      Object.defineProperty(winProto, "name", { value: "Window", writable: true, enumerable: false, configurable: true });
    } catch (e) {}
    void RealError;

    if (!P.resourceEntries) {
      const scriptUrl = String(P.scriptUrl || "");
      P.resourceEntries = scriptUrl
        ? [{ name: scriptUrl, initiatorType: "script", duration: 41.2, transferSize: 283740, encodedBodySize: 283416, decodedBodySize: 841441, startTime: 120.5 }]
        : [];
    }
    if (P.navigationType) {
      getters(performanceProto, {
        navigation: function () {
          return host({ type: P.navigationType === "reload" ? 1 : 0, redirectCount: 0 }, "PerformanceNavigation");
        },
      });
    }
  })();

  (function applyProtoShapes() {
    const shapes = P.protoShapes || {};
    const protect = [Object.prototype, Function.prototype, Array.prototype, String.prototype, Number.prototype];

    function safe(target) {
      return target && protect.indexOf(target) < 0;
    }

    function shapeIt(key, target) {
      const spec = shapes[key];
      if (!spec || !spec.shape || !safe(target)) return;
      applyKeyShape(target, spec.shape);
    }

    const htmlDocProto = Object.getPrototypeOf(raw(document));
    const docProto = htmlDocProto ? Object.getPrototypeOf(htmlDocProto) : null;

    if (shapes["HTMLDocument.prototype"] && safe(htmlDocProto) && safe(docProto)) {
      const keep = shapes["HTMLDocument.prototype"].own || ["constructor"];
      for (const name of Object.getOwnPropertyNames(htmlDocProto)) {
        if (keep.indexOf(name) >= 0) continue;
        const d = Object.getOwnPropertyDescriptor(htmlDocProto, name);
        if (!d || !d.configurable) continue;
        try {
          if (!hasOwnRef.call(docProto, name)) Object.defineProperty(docProto, name, d);
          delete htmlDocProto[name];
        } catch (e) {}
      }
    }

    const winProto = Object.getPrototypeOf(winTarget);
    const winSpec = shapes["Window.prototype"];
    if (winSpec && safe(winProto)) {
      for (const entry of winSpec.shape || []) {
        const name = entry[0];
        if (hasOwnRef.call(winProto, name)) continue;
        const flags = entry[2] || "";
        let value;
        if (entry[1] === "number") value = Number(entry[4]);
        else if (entry[1] === "string") value = String(entry[4]);
        else if (entry[1] === "boolean") value = entry[4] === "true";
        try {
          Object.defineProperty(winProto, name, {
            value: value,
            writable: flags.indexOf("w") >= 0,
            enumerable: flags.indexOf("e") >= 0,
            configurable: flags.indexOf("c") >= 0,
          });
        } catch (e) {}
      }
    }

    shapeIt("Document.prototype", docProto);
    shapeIt("Screen.prototype", Object.getPrototypeOf(raw(screen)));
    shapeIt("Location.prototype", Object.getPrototypeOf(raw(location)));
    shapeIt("Performance.prototype", Object.getPrototypeOf(raw(performance)));
  })();

  bridge.fire = function (type) {
    listeners.filter((l) => l.type === type && l.owner !== "xhr").forEach((l) => {
      log("fire", l.owner + ":" + type, "");
      try {
        l.fn.call(win, host({ type }));
      } catch (e) {
        bridge.error("listener " + type, e);
      }
    });
  };
})(__bridge);
