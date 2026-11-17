const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

const raw = JSON.parse(readStdin());
const B = raw.buckets;
const absent = raw.misses || [];

const indexOf = {};
for (const bucket of ["canvas", "imageData", "glPixels", "text", "audio"]) {
  indexOf[bucket] = new Map();
  B[bucket].forEach((e, i) => indexOf[bucket].set(e.id, i));
}

const timeline = B.timeline
  .filter((t) => indexOf[t.bucket])
  .map((t) => ({ bucket: t.bucket, key: t.key, index: indexOf[t.bucket].get(t.key.split("#")[0]) }));

const alphas = new Set();
for (const bucket of ["canvas", "imageData"]) {
  for (const e of B[bucket]) {
    for (const op of e.spec.ops) if (op[0] === "set" && op[1] === "globalAlpha") alphas.add(Number(op[2]));
  }
}
for (let i = 0; i <= 20; i++) alphas.add(Math.round(i * 5) / 100);

const encoderDims = new Map();
for (const e of B.canvas) {
  if (e.spec.ops.some((op) => op[0] === "putImageData" || op[0] === "size")) {
    const key = e.spec.w + "x" + e.spec.h + e.spec.type;
    if (e.spec.w <= 64 && e.spec.h <= 64) encoderDims.set(key, { w: e.spec.w, h: e.spec.h, type: e.spec.type });
  }
}

const glVersion = (B.glPixels[0] && B.glPixels[0].spec.version) === 2 ? "webgl2" : "webgl";

const RECIPE = {
  version: "1",
  recipeId: crypto.createHash("sha1").update(JSON.stringify(B)).digest("hex").slice(0, 16),
  scriptUrl: raw.profile.scriptUrl,
  timeline: timeline,
  entries: {
    canvas: B.canvas.map((e) => ({ id: e.id, spec: e.spec })),
    imageData: B.imageData.map((e) => ({ id: e.id, spec: e.spec })),
    glPixels: B.glPixels.map((e) => ({ id: e.id, spec: e.spec })),
    text: B.text.map((e) => ({ id: e.id, spec: e.spec })),
    audio: B.audio.map((e) => ({ id: e.id, spec: e.spec })),
  },
  gl: {
    contextType: glVersion,
    versions: ["webgl", "webgl2"],
    params: B.glParams.map((e) => Number(e.name)),
    precision: B.glPrecision.map((e) => e.name),
    extensions: B.glExtensions.map((e) => e.name),
  },
  permissions: B.permissions.map((e) => e.name),
  codecs: B.codecs.map((e) => e.name),
  keys: B.keys.map((e) => e.name),
  absent: absent,
  blendAlphas: [...alphas].sort((a, b) => a - b),
  blendCanvas: B.imageData.length ? { w: B.imageData[B.imageData.length - 1].spec.cw, h: B.imageData[B.imageData.length - 1].spec.ch } : { w: 300, h: 150 },
  encoderSamples: [...encoderDims.values()],
};

const template = fs.readFileSync(path.join(__dirname, "collector_template.js"), "utf8");
if (template.indexOf("__RECIPE__") < 0) throw new Error("template marker missing");
process.stdout.write(template.replace("__RECIPE__", JSON.stringify(RECIPE)));
