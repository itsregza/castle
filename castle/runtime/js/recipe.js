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
  const buf = Buffer.alloc(65536);
  while (true) {
    let n = 0;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
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
const profile = job.profile || JSON.parse(fs.readFileSync(path.join(__dirname, "baseline.json"), "utf8"));
const waitMs = Number(job.waitMs || 8000);

const start = process.hrtime.bigint();
const recipe = {
  timeline: [],
  canvas: [],
  text: [],
  audio: [],
  imageData: [],
  glPixels: [],
  glParams: [],
  glExtensions: [],
  glSupportedExtensions: [],
  glPrecision: [],
  codecs: [],
  permissions: [],
  keys: [],
};
const seen = new Map();
const misses = [];
const errors = [];
const captures = [];
const handles = new Set();
let seq = 0;
let finished = false;

const recipeKinds = {
  glParam: "glParams",
  glExtension: "glExtensions",
  glSupportedExtensions: "glSupportedExtensions",
  glPrecision: "glPrecision",
  canPlayType: "codecs",
  permission: "permissions",
  keys: "keys",
};

function specId(spec) {
  return crypto.createHash("sha1").update(spec).digest("hex").slice(0, 16);
}

function record(bucket, spec) {
  const key = bucket + "|" + spec;
  let entry = seen.get(key);
  if (!entry) {
    entry = { id: specId(spec), spec: JSON.parse(spec), count: 0, first: seq };
    seen.set(key, entry);
    recipe[bucket].push(entry);
  }
  entry.count++;
  recipe.timeline.push({ bucket: bucket, key: entry.id + "#" + entry.count });
  return entry.id;
}

const bridge = {
  profile: JSON.stringify(profile),
  log(kind, p, value) {
    seq++;
    if (kind === "miss") {
      if (misses.indexOf(p) < 0) misses.push(p);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(recipeKinds, kind)) return;
    const bucket = recipeKinds[kind];
    const key = bucket + "|" + p;
    let entry = seen.get(key);
    if (!entry) {
      entry = { name: p, count: 0, first: seq };
      seen.set(key, entry);
      recipe[bucket].push(entry);
    }
    entry.count++;
  },
  now: () => Number(process.hrtime.bigint() - start) / 1e6,
  atob: (s) => Buffer.from(s, "base64").toString("latin1"),
  btoa: (s) => Buffer.from(s, "latin1").toString("base64"),
  seed: String(profile.seed || "recipe"),
  textWidth(font, text) {
    record("text", JSON.stringify({ font: String(font), text: String(text) }));
    const size = parseFloat((String(font).match(/([\d.]+)px/) || [0, 10])[1]);
    let w = 0;
    for (const ch of String(text)) {
      const c = ch.codePointAt(0);
      w += c < 128 ? (/[ilI.,:;'|!]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.83 : /[A-Z]/.test(ch) ? 0.66 : 0.52) : 1;
    }
    return Math.round(w * size * 1000) / 1000;
  },
  canvasData(spec) {
    record("canvas", spec);
    const s = JSON.parse(spec);
    const webp = s.type === "image/webp";
    const h = crypto.createHash("sha256").update(bridge.seed + spec).digest();
    const parts = [webp ? Buffer.from("52494646", "hex") : Buffer.from("89504e470d0a1a0a", "hex")];
    for (let i = 0; i < 96; i++) parts.push(crypto.createHash("sha256").update(h).update(String(i)).digest());
    return (webp ? "data:image/webp;base64," : "data:image/png;base64,") + Buffer.concat(parts).toString("base64");
  },
  audioSamples(spec) {
    record("audio", spec);
    const o = JSON.parse(spec);
    const out = new Array(o.length);
    for (let i = 0; i < o.length; i++) {
      const t = i / o.sampleRate;
      const x = Math.sin(2 * Math.PI * 10000 * t);
      out[i] = (o.graph || []).includes("compressor") ? Math.max(-0.3, Math.min(0.3, x * 0.42)) * (i < 128 ? i / 128 : 1) : x;
    }
    return JSON.stringify(out);
  },
  imageData(spec) {
    record("imageData", spec);
    return null;
  },
  glPixels(spec) {
    record("glPixels", spec);
    return null;
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
    captures.push({ at: Date.now(), bytes: req.body ? req.body.length : 0, url: req.url, method: req.method });
    return null;
  },
  cookie() {},
  error(where, e) {
    errors.push({ where: where, error: e && e.stack ? String(e.stack) : String(e) });
  },
};

process.on("uncaughtException", (e) => bridge.error("uncaught", e));
process.on("unhandledRejection", (e) => bridge.error("unhandledRejection", e));

const ctx = vm.createContext({ __bridge: bridge });
vm.runInContext(fs.readFileSync(path.join(__dirname, "env.js"), "utf8"), ctx, { filename: "env.js" });
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
  for (const bucket of Object.keys(recipe)) {
    if (bucket !== "timeline") recipe[bucket].sort((a, b) => a.first - b.first);
  }
  process.stdout.write(JSON.stringify({ profile: profile, buckets: recipe, misses: misses, captures: captures, errors: errors.slice(0, 3) }), () => process.exit(0));
}

const deadline = Date.now() + waitMs;
const poll = setInterval(() => {
  const done = captures.length && Date.now() > captures[captures.length - 1].at + 400;
  if (done || Date.now() > deadline) {
    clearInterval(poll);
    finish();
  }
}, 50);
