const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const webcrypto = require("crypto").webcrypto;
const keyStore = new Map();
let keySeq = 0;

function reviveAlg(a) {
  if (a == null || typeof a !== "object") return a;
  if (a.__bytes !== undefined) return Buffer.from(a.__bytes, "base64");
  const out = {};
  for (const k of Object.keys(a)) out[k] = reviveAlg(a[k]);
  return out;
}

function keyInfo(handle, key) {
  return { handle: handle, type: key.type, extractable: key.extractable, algorithm: key.algorithm, usages: key.usages };
}

function storeKey(key) {
  const handle = "k" + ++keySeq;
  keyStore.set(handle, key);
  return keyInfo(handle, key);
}

async function hostSubtle(job) {
  const s = webcrypto.subtle;
  const data = job.data ? Buffer.from(job.data, "base64") : undefined;
  const alg = reviveAlg(job.args && job.args.alg);
  const key = job.key ? keyStore.get(job.key) : null;
  switch (job.op) {
    case "digest":
      return { kind: "bytes", value: Buffer.from(await s.digest(reviveAlg(job.args.alg), data)).toString("base64") };
    case "encrypt":
      return { kind: "bytes", value: Buffer.from(await s.encrypt(alg, key, data)).toString("base64") };
    case "decrypt":
      return { kind: "bytes", value: Buffer.from(await s.decrypt(alg, key, data)).toString("base64") };
    case "sign":
      return { kind: "bytes", value: Buffer.from(await s.sign(alg, key, data)).toString("base64") };
    case "verify":
      return { kind: "boolean", value: await s.verify(alg, key, Buffer.from(job.args.sig, "base64"), data) };
    case "importKey": {
      const material = job.args.format === "jwk" ? job.args.jwk : data;
      return { kind: "key", ...storeKey(await s.importKey(job.args.format, material, alg, job.args.extractable, job.args.usages)) };
    }
    case "exportKey": {
      const out = await s.exportKey(job.args.format, key);
      if (job.args.format === "jwk") return { kind: "json", value: out };
      return { kind: "bytes", value: Buffer.from(out).toString("base64") };
    }
    case "generateKey": {
      const made = await s.generateKey(alg, job.args.extractable, job.args.usages);
      if (made && made.publicKey) return { kind: "keypair", publicKey: storeKey(made.publicKey), privateKey: storeKey(made.privateKey) };
      return { kind: "key", ...storeKey(made) };
    }
    case "deriveBits":
      return { kind: "bytes", value: Buffer.from(await s.deriveBits(alg, key, job.args.length)).toString("base64") };
    case "deriveKey":
      return { kind: "key", ...storeKey(await s.deriveKey(alg, key, reviveAlg(job.args.derived), job.args.extractable, job.args.usages)) };
    default:
      throw new Error("unsupported subtle op " + job.op);
  }
}


function readStdin() {
  const chunks = [];
  const fd = 0;
  const buf = Buffer.alloc(65536);
  while (true) {
    let n = 0;
    try {
      n = fs.readSync(fd, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === "EAGAIN") continue;
      if (e.code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const job = JSON.parse(readStdin());
const profile = job.profile || {};
const collected = profile.collected || {};
const calibration = profile.calibration || {};
const waitMs = Number(job.waitMs || 8000);

const start = process.hrtime.bigint();
const captures = [];
const errors = [];
const misses = [];
const computed = [];
const stale = [];
const counts = new Map();
const handles = new Set();
const realms = [];
let finished = false;

function specId(spec) {
  return crypto.createHash("sha1").update(spec).digest("hex").slice(0, 16);
}

function occurrence(bucket, spec) {
  const key = bucket + "|" + spec;
  const n = (counts.get(key) || 0) + 1;
  counts.set(key, n);
  return specId(spec) + "#" + n;
}

const bucketCounts = {};

function recordedCount(bucket, id) {
  const table = collected[bucket] || {};
  const seen = bucketCounts[bucket] || (bucketCounts[bucket] = {});
  if (seen[id] === undefined) {
    let n = 0;
    while (Object.prototype.hasOwnProperty.call(table, id + "#" + (n + 1))) n++;
    seen[id] = n;
  }
  return seen[id];
}

function lookup(bucket, key) {
  const table = collected[bucket];
  if (!table) return undefined;
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  const parts = key.split("#");
  const total = recordedCount(bucket, parts[0]);
  if (!total) return undefined;
  const wrapped = parts[0] + "#" + (((Number(parts[1]) - 1) % total) + 1);
  if (!Object.prototype.hasOwnProperty.call(table, wrapped)) return undefined;
  return table[wrapped];
}

function replay(bucket, key) {
  const got = lookup(bucket, key);
  if (got !== undefined) return got;
  misses.push(bucket + " " + key);
  return null;
}

function parseColor(v) {
  const s = String(v).trim();
  let m = s.match(/^#([0-9a-fA-F]{3})$/);
  if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 1];
  m = s.match(/^#([0-9a-fA-F]{6})$/);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(",").map((x) => parseFloat(x.trim()));
    return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
  }
  return null;
}

function mulDiv255Round(a, b) {
  const prod = a * b + 128;
  return (prod + (prod >> 8)) >> 8;
}

function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function premulByte(channel, alpha, alphaByte) {
  const table = calibration.premul && calibration.premul[String(alpha)];
  if (table) {
    const row = Buffer.from(table, "base64");
    if (row.length === 256) return row[channel];
  }
  return Math.round(channel * alpha);
}

function blendImageData(spec) {
  if (!calibration.premul && !calibration.blend) return null;
  const W = spec.w | 0;
  const H = spec.h | 0;
  const buf = new Int32Array(W * H * 4);
  let alpha = 1;
  let fill = "#000000";
  let drew = false;
  for (const op of spec.ops) {
    if (op[0] === "size") continue;
    if (op[0] === "set" && op[1] === "globalAlpha") {
      alpha = Number(op[2]);
      continue;
    }
    if (op[0] === "set" && op[1] === "fillStyle") {
      fill = op[2];
      continue;
    }
    if (op[0] !== "fillRect") return null;
    const col = parseColor(fill);
    if (!col || col[3] !== 1) return null;
    const sa = Math.round(alpha * 255);
    const inv = 255 - sa;
    const src = [premulByte(col[0], alpha, sa), premulByte(col[1], alpha, sa), premulByte(col[2], alpha, sa)];
    for (let y = op[2] | 0; y < (op[2] | 0) + (op[4] | 0); y++) {
      for (let x = op[1] | 0; x < (op[1] | 0) + (op[3] | 0); x++) {
        if (x < spec.x || y < spec.y || x >= spec.x + W || y >= spec.y + H) continue;
        const i = ((y - spec.y) * W + (x - spec.x)) * 4;
        buf[i] = src[0] + mulDiv255Round(buf[i], inv);
        buf[i + 1] = src[1] + mulDiv255Round(buf[i + 1], inv);
        buf[i + 2] = src[2] + mulDiv255Round(buf[i + 2], inv);
        buf[i + 3] = sa + mulDiv255Round(buf[i + 3], inv);
        drew = true;
      }
    }
  }
  if (!drew) return null;
  const out = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const a = buf[p * 4 + 3];
    out[p * 4 + 3] = a;
    for (let c = 0; c < 3; c++) out[p * 4 + c] = a === 0 ? 0 : Math.min(255, roundHalfEven((buf[p * 4 + c] * 255) / a));
  }
  return out.toString("base64");
}

function syntheticCanvas(spec) {
  const s = JSON.parse(spec);
  const webp = s.type === "image/webp";
  const h = crypto.createHash("sha256").update(bridge.seed + spec).digest();
  const parts = [webp ? Buffer.from("52494646", "hex") : Buffer.from("89504e470d0a1a0a", "hex")];
  for (let i = 0; i < 96; i++) parts.push(crypto.createHash("sha256").update(h).update(String(i)).digest());
  return (webp ? "data:image/webp;base64," : "data:image/png;base64,") + Buffer.concat(parts).toString("base64");
}

function syntheticWidth(font, text) {
  const size = parseFloat((String(font).match(/([\d.]+)px/) || [0, 10])[1]);
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    w += c < 128 ? (/[ilI.,:;'|!]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.83 : /[A-Z]/.test(ch) ? 0.66 : 0.52) : 1;
  }
  return Math.round(w * size * 1000) / 1000;
}

function syntheticAudio(spec) {
  const o = JSON.parse(spec);
  const out = new Array(o.length);
  for (let i = 0; i < o.length; i++) {
    const t = i / o.sampleRate;
    const x = Math.sin(2 * Math.PI * 10000 * t);
    out[i] = (o.graph || []).includes("compressor") ? Math.max(-0.3, Math.min(0.3, x * 0.42)) * (i < 128 ? i / 128 : 1) : x;
  }
  return JSON.stringify(out);
}

const bridge = {
  profile: JSON.stringify(profile),
  log: function (kind, p, value) {
    if (kind === "error") errors.push({ where: p, error: String(value) });
  },
  now: () => Number(process.hrtime.bigint() - start) / 1e6,
  atob: (s) => Buffer.from(s, "base64").toString("latin1"),
  btoa: (s) => Buffer.from(s, "latin1").toString("base64"),
  seed: String(profile.seed || "default"),
  textWidth(font, text) {
    const key = occurrence("text", JSON.stringify({ font: String(font), text: String(text) }));
    const got = lookup("text", key);
    if (got === undefined) misses.push("text " + key);
    if (got) return got[0];
    return syntheticWidth(font, String(text));
  },
  textMetrics(font, text) {
    const key = specId(JSON.stringify({ font: String(font), text: String(text) }));
    const table = collected.text || {};
    for (let n = 1; n <= 8; n++) {
      const v = table[key + "#" + n];
      if (v) return v;
    }
    return null;
  },
  canvasData(spec) {
    const key = occurrence("canvas", spec);
    const got = lookup("canvas", key);
    if (got === undefined) misses.push("canvas " + key);
    if (got) {
      if (/putImageData/.test(spec) && computed.length) stale.push("canvas " + key);
      return got;
    }
    return syntheticCanvas(spec);
  },
  audioSamples(spec) {
    const got = replay("audio", occurrence("audio", spec));
    if (got) return JSON.stringify(got);
    return syntheticAudio(spec);
  },
  imageData(spec) {
    const key = occurrence("imageData", spec);
    const exact = collected.imageData && Object.prototype.hasOwnProperty.call(collected.imageData, key) ? collected.imageData[key] : undefined;
    if (exact !== undefined) return exact;
    const made = blendImageData(JSON.parse(spec));
    if (made) {
      computed.push("imageData " + key);
      return made;
    }
    misses.push("imageData " + key);
    return null;
  },
  glPixels(spec) {
    return replay("glPixels", occurrence("glPixels", spec));
  },
  randomBytes(n) {
    return crypto.randomBytes(Math.max(0, n | 0)).toString("base64");
  },
  randomUUID() {
    return crypto.randomUUID();
  },
  subtle(payloadJson, callback) {
    let job;
    try {
      job = JSON.parse(payloadJson);
    } catch (e) {
      callback("bad subtle payload", null);
      return;
    }
    hostSubtle(job).then(
      (res) => callback(null, JSON.stringify(res)),
      (err) => callback(String((err && err.message) || err), null)
    );
  },
  utf8Encode: (s) => JSON.stringify(Array.from(Buffer.from(s, "utf8"))),
  utf8Decode: (j) => Buffer.from(JSON.parse(j)).toString("utf8"),
  parseUrl(u, base) {
    let x;
    try {
      x = base === undefined ? new URL(u) : new URL(u, base);
    } catch (e) {
      return JSON.stringify({ error: true });
    }
    return JSON.stringify({ href: x.href, protocol: x.protocol, host: x.host, hostname: x.hostname, port: x.port, pathname: x.pathname, search: x.search, hash: x.hash, origin: x.origin });
  },
  schedule(fn, ms, repeat) {
    const h = repeat ? setInterval(fn, Math.max(0, Number(ms) || 0)) : setTimeout(fn, Math.max(0, Number(ms) || 0));
    handles.add(h);
    return h;
  },
  cancel(h) {
    clearTimeout(h);
    clearInterval(h);
    handles.delete(h);
  },
  capture(req) {
    captures.push(Object.assign({ at: Date.now() }, req));
    return null;
  },
  cookie() {},
  realm() {
    if (realms.length >= 6) return realms[realms.length - 1];
    try {
      const child = vm.createContext({ __bridge: bridge });
      vm.runInContext(envSource, child, { filename: "env.js" });
      vm.runInContext("delete globalThis.__bridge", child);
      const win = vm.runInContext("window", child);
      realms.push(win);
      return win;
    } catch (e) {
      errors.push({ where: "realm", error: String(e && e.message) });
      return null;
    }
  },
  error(where, e) {
    errors.push({ where, error: e && e.stack ? String(e.stack) : String(e) });
  },
};

process.on("uncaughtException", (e) => bridge.error("uncaught", e));
process.on("unhandledRejection", (e) => bridge.error("unhandledRejection", e));

const envSource = fs.readFileSync(path.join(__dirname, "env.js"), "utf8");
const ctx = vm.createContext({ __bridge: bridge });
vm.runInContext(envSource, ctx, { filename: "env.js" });
vm.runInContext("delete globalThis.__bridge", ctx);

try {
  vm.runInContext(job.script, ctx, { filename: profile.scriptUrl || "script.js" });
} catch (e) {
  bridge.error("top-level", e);
}

setTimeout(() => {
  if (typeof bridge.fire === "function") {
    bridge.fire("DOMContentLoaded");
    bridge.fire("load");
  }
}, 50);

function finish() {
  if (finished) return;
  finished = true;
  for (const h of handles) {
    clearTimeout(h);
    clearInterval(h);
  }
  const post = captures.filter((c) => String(c.method).toUpperCase() === "POST" && c.body);
  const main = post[post.length - 1] || null;
  const result = {
    payload: main ? main.body : null,
    url: main ? main.url : null,
    ms: Math.round(bridge.now()),
    misses: misses,
    stale: stale,
    errors: errors.slice(0, 5),
  };
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

const deadline = Date.now() + waitMs;
const poll = setInterval(() => {
  const done = captures.length && Date.now() > captures[captures.length - 1].at + 300;
  if (done || Date.now() > deadline) {
    clearInterval(poll);
    finish();
  }
}, 50);
