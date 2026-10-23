/**
 * Print the extension's own answer for a clip, so it can be diffed against
 * the web app's analysis of the same file.
 *
 * Drives the shipped code the way Chrome does: since 1.0.2 the offscreen
 * document owns the backend conversation (a Blob cannot cross a runtime
 * message, and a service worker would be idle-killed mid-stream). This
 * script uploads the clip, then runs the shipped ANALYZE handler and waits
 * for the posted outcome.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "..", "extension");
const BACKEND = process.argv[2];
const VIDEO = process.argv[3];
const TAB_ID = 7;

let listener = null;
let posted = null;
const chromeStub = {
  storage: { local: { get: async () => ({ backend: BACKEND, captureSeconds: 20 }) } },
  runtime: {
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: async (m) => {
      if (m && (m.type === "ANALYSIS_RESULT" || m.type === "CAPTURE_ERROR")) {
        posted = m;
      }
      return {};
    },
  },
  offscreen: { hasDocument: async () => true, createDocument: async () => {} },
  tabCapture: { getMediaStreamId: async () => "s" },
  tabs: { sendMessage: async () => {}, query: async () => [] },
  scripting: { executeScript: async () => {} },
};

const src = readFileSync(join(EXT, "offscreen.js"), "utf-8");
new Function(
  "chrome", "fetch", "FormData", "Blob", "console",
  src
)(chromeStub, fetch, FormData, Blob, console);

if (!listener) throw new Error("the offscreen script registered no listener");

// 1. upload, exactly like the extension's offscreen document
const form = new FormData();
form.append(
  "files",
  new Blob([readFileSync(VIDEO)], { type: "video/mp4" }),
  "clip.mp4"
);
const up = await fetch(BACKEND + "/gradio_api/upload", {
  method: "POST",
  body: form,
});
if (!up.ok) throw new Error(`HTTP ${up.status} while uploading`);
const serverPath = (await up.json())[0];

// 2. analyse through the shipped handler and wait for the posted outcome
listener({ type: "ANALYZE", tabId: TAB_ID, serverPath, backend: BACKEND }, null, () => {});
const horizon = Date.now() + 300000; // 60 s of clip is roughly 20 s of compute
while (!posted && Date.now() < horizon) {
  await new Promise((r) => setTimeout(r, 100));
}
if (!posted) throw new Error("the analysis posted no result in time");
if (posted.type === "CAPTURE_ERROR") {
  throw new Error(posted.message || "backend error");
}
const res = posted.result;

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
