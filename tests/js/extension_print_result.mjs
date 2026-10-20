/**
 * Print the extension's own answer for a clip, so it can be diffed against
 * the web app's analysis of the same file.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "..", "extension");
const BACKEND = process.argv[2];
const VIDEO = process.argv[3];

const chromeStub = {
  storage: { local: { get: async () => ({ backend: BACKEND, captureSeconds: 20 }) } },
  runtime: { onMessage: { addListener: () => {} }, sendMessage: async () => ({}) },
  offscreen: { hasDocument: async () => true, createDocument: async () => {} },
  tabCapture: { getMediaStreamId: async () => "s" },
  tabs: { sendMessage: async () => {}, query: async () => [] },
  scripting: { executeScript: async () => {} },
};

const src = readFileSync(join(EXT, "background.js"), "utf-8");
const analyseOnBackend = new Function(
  "chrome", "fetch", "FormData", "AbortController", "console", "URL", "Blob",
  `${src}\n;return analyseOnBackend;`
)(chromeStub, fetch, FormData, AbortController, console, URL, Blob);

const res = await analyseOnBackend.call(
  { normaliseBackend: (u) => u },
  BACKEND,
  new Blob([readFileSync(VIDEO)], { type: "video/mp4" }),
  "clip.mp4"
);

const round = (v, d = 3) => (v == null || !isFinite(v) ? null : Number(v.toFixed(d)));
console.log(
  "EXTENSION:",
  JSON.stringify({
    verdict: res.verdict,
    score: round(res.score),
    hr: Object.values(res.per_roi_hr).map((v) => round(v)),
    agree: round(res.region_agreement_bpm),
    snr: round(res.snr),
    valid: round(res.face_valid_frac, 4),
  })
);
