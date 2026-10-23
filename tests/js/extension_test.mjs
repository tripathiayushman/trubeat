/**
 * Automated tests for the TrueBeat browser extension.
 *
 * These load the *shipped* extension files (not copies) and exercise the
 * real code paths:
 *   1. background.js — the Gradio API client (upload -> call -> SSE) against
 *      a live `trubeat serve`, plus the backend-unreachable path;
 *   2. overlay.js — the verdict -> colour/copy mapping and the standing
 *      caveat wording;
 *   3. offscreen.js — the black-frame heuristic;
 *   4. a static audit: no remote code, no telemetry hosts, no requests to
 *      anything but the configured backend.
 *
 * Run:  node tests/js/extension_test.mjs [--backend http://127.0.0.1:7860]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "..", "extension");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// --------------------------------------------------------------- fixtures

const backendArgIndex = process.argv.indexOf("--backend");
const videoArgIndex = process.argv.indexOf("--video");
const BACKEND =
  backendArgIndex > -1
    ? process.argv[backendArgIndex + 1]
    : process.env.TRUBEAT_BACKEND || "http://127.0.0.1:7860";
const VIDEO =
  videoArgIndex > -1
    ? process.argv[videoArgIndex + 1]
    : join(HERE, "..", "..", "data", "raw", "ubfc_rppg", "subject1", "vid.avi");

/** Model the browser's message fidelity: chrome.runtime messages are
 * JSON-serialised, so anything that cannot be JSON (a Blob) arrives as {}. */
function rtMessage(m) {
  return JSON.parse(JSON.stringify(m));
}

/** A chrome API stub good enough for background.js to load. Every outbound
 * message goes through the same serialisation the real browser applies. */
function chromeStub(overrides = {}) {
  const store = { backend: BACKEND, captureSeconds: 20 };
  return {
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : Object.keys(keys);
          for (const k of list) out[k] = store[k] ?? keys[k];
          return out;
        },
        set: async (obj) => Object.assign(store, obj),
      },
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (m) => rtMessage(m),
      id: "test",
    },
    offscreen: {
      hasDocument: async () => true,
      createDocument: async () => {},
    },
    tabCapture: { getMediaStreamId: async () => "stream-id" },
    tabs: { sendMessage: async (_tab, m) => rtMessage(m), query: async () => [] },
    scripting: { executeScript: async () => {}, insertCSS: async () => {} },
    ...overrides,
  };
}

/** Load a classic extension script into a fresh context with our stubs. */
function loadScript(file, globals) {
  const src = readFileSync(join(EXT, file), "utf-8");
  const fn = new Function(
    ...Object.keys(globals),
    `${src}\n;return typeof analyseOnBackend !== "undefined" ? analyseOnBackend : undefined;`
  );
  return fn(...Object.values(globals));
}

// ------------------------------------------------- 1. background API client

section("1. background.js — Gradio API client");
{
  const globals = {
    chrome: chromeStub(),
    fetch,
    FormData,
    AbortController,
    console,
    URL,
    Blob,
  };
  const analyseOnBackend = loadScript("background.js", globals);

  // Backend unreachable -> an honest error, never a fabricated verdict.
  const dead = await analyseOnBackend.call(
    { normaliseBackend: (u) => u },
    "http://127.0.0.1:9",
    "/tmp/gradio/truebeat/dead/dead.webm"
  ).then(
    () => null,
    (e) => e
  );
  check(
    "unreachable backend rejects with an error",
    dead !== null && /unreachable|HTTP|fetch failed|ECONNREFUSED/i.test(String(dead)),
    String(dead).slice(0, 120)
  );

  if (BACKEND) {
    // Is a backend actually up? If not, the live checks are skipped (CI has
    // no backend) rather than failed — the offline checks still run.
    let up = false;
    try {
      const ping = await fetch(BACKEND + "/gradio_api/info", {
        signal: AbortSignal.timeout(4000),
      });
      up = ping.ok;
    } catch (_) {
      up = false;
    }
    if (!up) {
      console.log(
        `  skip live backend checks (no backend at ${BACKEND}) — ` +
          "start one with `trubeat serve` to exercise them"
      );
    } else {
      let result = null;
      let error = null;
      try {
        // The harness uploads like the extension does (the offscreen
        // document owns the POST) and then analyses the server-side copy.
        const form = new FormData();
        form.append(
          "files",
          new Blob([readFileSync(VIDEO)], { type: "video/mp4" }),
          "test.mp4"
        );
        const up = await fetch(BACKEND + "/gradio_api/upload", {
          method: "POST",
          body: form,
        });
        if (!up.ok) throw new Error("HTTP " + up.status + " while uploading");
        const path = (await up.json())[0];
        result = await analyseOnBackend.call(
          { normaliseBackend: (u) => u },
          BACKEND,
          path
        );
      } catch (e) {
        error = e;
      }
      if (error) {
        check(
          "live backend returns a verdict",
          false,
          "backend error: " + String(error.message || error).slice(0, 200)
        );
      } else {
        check("live backend returns a verdict", !!result, "no result");
        check(
          "verdict is one of the three states",
          ["real", "fake", "inconclusive"].includes(result.verdict),
          String(result.verdict)
        );
        check("result carries the score", "score" in result);
        check("result carries hr_bpm", "hr_bpm" in result);
        check(
          "result carries region_agreement_bpm",
          "region_agreement_bpm" in result
        );
        check("result carries snr", "snr" in result);
        check("result carries qc", !!result.qc && typeof result.qc === "object");
        check("result carries the caveat", /face-swap/i.test(result.caveat || ""));
        check(
          "headline uses the app wording",
          /Pulse consistent|Pulse inconsistent|Inconclusive/.test(
            result.headline || ""
          ),
          String(result.headline)
        );
      }
    }
  }
}

// ------------------------------------------------ 2. overlay verdict mapping

section("2. overlay.js — verdict mapping and copy");
{
  const globals = {
    chrome: chromeStub(),
    window: {},
    document: {
      createElement: () => ({
        attachShadow: () => ({
          append: () => {},
          appendChild: () => {},
        }),
        style: {},
        querySelector: () => ({ addEventListener: () => {}, style: {} }),
        set innerHTML(v) {},
        get innerHTML() {
          return "";
        },
        remove: () => {},
      }),
      body: { appendChild: () => {} },
      getElementById: () => null,
    },
    console,
  };
  // The overlay guards against double-injection with window.__trueBeatOverlay.
  globals.window = {};
  loadScript("overlay.js", globals);

  const styles = globalThis.__trueBeatVerdictStyles;
  const caveat = globalThis.__trueBeatStandingCaveat;
  check("overlay exposes the three verdict styles", !!styles);
  if (styles) {
    check("real -> green", styles.real.accent === "#22c55e", styles.real.accent);
    check("fake -> red", styles.fake.accent === "#ef4444", styles.fake.accent);
    check(
      "inconclusive -> amber",
      styles.inconclusive.accent === "#f59e0b",
      styles.inconclusive.accent
    );
    check(
      "the three states are the app's wording",
      styles.real.label === "Pulse consistent: likely real" &&
        styles.fake.label === "Pulse inconsistent: pixel-replacement pattern" &&
        styles.inconclusive.label === "Inconclusive",
      JSON.stringify(styles)
    );
  }
  check("overlay carries the standing caveat", /Face2Face/.test(caveat || ""));
  check(
    "caveat names the out-of-scope families",
    /Face2Face/.test(caveat || "") && /NeuralTextures/.test(caveat || "")
  );
}

// ------------------------------------------------ 3. black-frame heuristic

section("3. offscreen.js — black-frame guard");
{
  const globals = {
    chrome: chromeStub(),
    window: { MediaRecorder: undefined },
    document: { createElement: () => ({ getContext: () => null }) },
    console,
  };
  loadScript("offscreen.js", globals);
  const isBlack = globalThis.__trueBeatIsBlackFrame;
  check("offscreen exposes the black-frame test", typeof isBlack === "function");
  if (isBlack) {
    check("a fully black frame is black", isBlack(2, 1) === true);
    check("a dark but moving frame is not black", isBlack(2, 40) === false);
    check("a bright frame is not black", isBlack(180, 5) === false);
    check("a normal frame is not black", isBlack(90, 25) === false);
  }
}

// ------------------------------------------------ 3b. tab-capture wiring

section("3b. offscreen.js — tab-capture wiring");
{
  // Static: the real API is navigator.mediaDevices, never chrome.mediaStream.
  const src = readFileSync(join(EXT, "offscreen.js"), "utf-8");
  check(
    "offscreen opens the stream via navigator.mediaDevices.getUserMedia",
    src.includes("navigator.mediaDevices.getUserMedia")
  );
  check(
    "offscreen never touches the non-existent chrome.mediaStream",
    !src.includes("chrome.mediaStream")
  );

  // Behavioural: with a stubbed navigator.mediaDevices, starting a capture
  // passes the streamId through as chromeMediaSourceId and reports success.
  const trackStub = {
    addEventListener: () => {},
    getSettings: () => ({ width: 640, height: 360 }),
  };
  const streamStub = { getVideoTracks: () => [trackStub], getTracks: () => [] };
  const RecorderStub = function () {
    this.state = "recording";
    this.start = () => {};
    this.stop = () => {};
  };
  RecorderStub.isTypeSupported = () => true;

  const baseGlobals = {
    window: { MediaRecorder: RecorderStub },
    MediaRecorder: RecorderStub,
    document: { createElement: () => ({ getContext: () => null }) },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    Blob,
    console,
  };

  const listeners = [];
  const sent = [];
  const gUM = async (constraints) => {
    gUM.seen = constraints;
    return streamStub;
  };
  loadScript("offscreen.js", {
    ...baseGlobals,
    chrome: chromeStub({
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: async (m) => {
          sent.push(rtMessage(m));
          return {};
        },
        id: "test",
      },
    }),
    navigator: { mediaDevices: { getUserMedia: gUM } },
  });

  let response = null;
  listeners[0](
    { type: "OFFSCREEN_START", streamId: "sid-123", tabId: 7, seconds: 20 },
    null,
    (r) => {
      response = r;
    }
  );
  await new Promise((r) => setTimeout(r, 30));
  const c = gUM.seen || {};
  check(
    "the streamId flows through as chromeMediaSourceId",
    c.audio === false &&
      !!c.video &&
      !!c.video.mandatory &&
      c.video.mandatory.chromeMediaSource === "tab" &&
      c.video.mandatory.chromeMediaSourceId === "sid-123",
    JSON.stringify(c)
  );
  check(
    "a running capture answers ok, not an error",
    response && response.ok === true &&
      !sent.some((m) => m.type === "CAPTURE_ERROR"),
    JSON.stringify(response)
  );

  // Guard: a context without mediaDevices must fail with a readable message.
  const listeners2 = [];
  const sent2 = [];
  loadScript("offscreen.js", {
    ...baseGlobals,
    chrome: chromeStub({
      runtime: {
        onMessage: { addListener: (fn) => listeners2.push(fn) },
        sendMessage: async (m) => {
          sent2.push(rtMessage(m));
          return {};
        },
        id: "test",
      },
    }),
    navigator: {},
  });
  let response2 = null;
  listeners2[0](
    { type: "OFFSCREEN_START", streamId: "sid-x", tabId: 8, seconds: 20 },
    null,
    (r) => {
      response2 = r;
    }
  );
  await new Promise((r) => setTimeout(r, 30));
  check(
    "a missing mediaDevices yields the readable guard message",
    response2 && response2.ok === false &&
      /Tab capture is unavailable/.test(sent2.map((m) => m.message || "").join(" ")),
    JSON.stringify({ response: response2, sent: sent2 })
  );
}

// ------------------------- 3c. capture-to-backend pipeline (1.0.2 bug) ----

section("3c. capture-to-backend pipeline (Blobs stay in the offscreen document)");
{
  // The reported bug: offscreen.js posted the recorded Blob inside a
  // CAPTURE_DONE runtime message; the browser JSON-serialises such a message
  // and the Blob arrives in background.js as {}, so FormData.append threw.
  // The honest model: a Blob never crosses the runtime. The offscreen
  // document uploads the clip itself and reports only a server path.

  const trackStub = {
    addEventListener: () => {},
    getSettings: () => ({ width: 640, height: 360 }),
  };
  const streamStub = { getVideoTracks: () => [trackStub], getTracks: () => [] };
  let recorderInstance = null;
  const RecorderStub = function () {
    recorderInstance = this;
    this.state = "recording";
    this.start = () => {};
    this.stop = () => {};
  };
  RecorderStub.isTypeSupported = () => true;

  const baseGlobals = {
    window: { MediaRecorder: RecorderStub },
    MediaRecorder: RecorderStub,
    document: { createElement: () => ({ getContext: () => null }) },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    Blob,
    console,
  };

  // --- offscreen: a real Blob is uploaded; what crosses the runtime is a
  // --- serialisable server path, never the clip.
  const listenersO = [];
  const sentO = [];
  const fetchLog = [];
  const gUM = async (constraints) => {
    gUM.seen = constraints;
    return streamStub;
  };
  loadScript("offscreen.js", {
    ...baseGlobals,
    fetch: async (url, opts) => {
      fetchLog.push({ url: String(url), body: opts && opts.body });
      return {
        ok: true,
        status: 200,
        json: async () => ["/tmp/gradio/truebeat/uploads/cap.webm"],
      };
    },
    FormData,
    chrome: chromeStub({
      runtime: {
        onMessage: { addListener: (fn) => listenersO.push(fn) },
        sendMessage: async (m) => {
          sentO.push(rtMessage(m));
          return {};
        },
        id: "test",
      },
    }),
    navigator: { mediaDevices: { getUserMedia: gUM } },
  });

  listenersO[0](
    {
      type: "OFFSCREEN_START",
      streamId: "sid-123",
      tabId: 7,
      seconds: 20,
      backend: "http://127.0.0.1:9",
    },
    null,
    () => {}
  );
  await new Promise((r) => setTimeout(r, 30));
  recorderInstance.ondataavailable({
    data: new Blob([new Uint8Array(96).fill(7)], { type: "video/webm" }),
  });
  recorderInstance.onstop();
  await new Promise((r) => setTimeout(r, 60));

  check(
    "offscreen uploads the clip to the backend's upload endpoint",
    fetchLog.some(
      (f) =>
        f.url === "http://127.0.0.1:9/gradio_api/upload" &&
        f.body instanceof FormData
    ),
    JSON.stringify(fetchLog.map((f) => f.url))
  );
  const lastFromOffscreen = sentO[sentO.length - 1];
  check(
    "the message crossing the runtime is a serialisable server path",
    lastFromOffscreen &&
      lastFromOffscreen.type === "CAPTURE_UPLOADED" &&
      typeof lastFromOffscreen.serverPath === "string" &&
      lastFromOffscreen.serverPath.length > 0 &&
      lastFromOffscreen.tabId === 7,
    JSON.stringify(lastFromOffscreen)
  );
  check(
    "no blob slips through the runtime message",
    lastFromOffscreen && !("blob" in lastFromOffscreen),
    JSON.stringify(lastFromOffscreen)
  );

  // --- background: fed that serialised message, with stubbed backend
  // --- fetches, it completes call + SSE and pushes the result overlay.
  const listenersB = [];
  const statesB = [];
  const stubSettings = { backend: "http://127.0.0.1:9", captureSeconds: 20 };
  const callsB = [];
  const verdict = {
    verdict: "fake",
    headline: "Pulse inconsistent: pixel-replacement pattern detected",
    score: 0.91,
    caveat: "Detects face-swap-style fakes: reenactment fakes keep the pulse.",
  };
  const fetchForBackground = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/gradio_api/info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ named_endpoints: { "/analyze_video": {} } }),
      };
    }
    if (u.endsWith("/gradio_api/call/analyze_video")) {
      callsB.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ event_id: "ev-1" }) };
    }
    if (u.includes("/gradio_api/call/analyze_video/")) {
      const bytes = new TextEncoder().encode(
        `event: complete\ndata: ${JSON.stringify([JSON.stringify(verdict)])}\n\n`
      );
      let tick = 0;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () =>
              tick++ === 0
                ? { done: false, value: bytes }
                : { done: true },
          }),
        },
      };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  loadScript("background.js", {
    chrome: chromeStub({
      storage: {
        local: {
          get: async (keys) => ({ ...keys, ...stubSettings }),
          set: async (o) => Object.assign(stubSettings, o),
        },
      },
      runtime: {
        onMessage: { addListener: (fn) => listenersB.push(fn) },
        sendMessage: async (m) => {
          sentO.push(rtMessage(m));
          return {};
        },
        id: "test",
      },
      tabs: {
        sendMessage: async (_tab, m) => {
          statesB.push(rtMessage(m));
          return {};
        },
        query: async () => [],
      },
    }),
    fetch: fetchForBackground,
    AbortController,
    console,
    URL,
    Blob,
  });

  // The reported bug, modelled honestly: feed background the serialised
  // remains of a blob message ({}), not a real Blob.
  listenersB[0](
    { type: "CAPTURE_UPLOADED", tabId: 7, blob: {}, filename: "x.webm" },
    null,
    () => {}
  );
  await new Promise((r) => setTimeout(r, 40));
  const badState = statesB[statesB.length - 1];
  check(
    "an unusable server path pushes a readable backend error",
    badState && badState.type === "TRUEBEAT_STATE" &&
      badState.payload.state === "error" &&
      badState.payload.title === "Backend error",
    JSON.stringify(badState)
  );

  listenersB[0](lastFromOffscreen, null, () => {});
  await new Promise((r) => setTimeout(r, 80));
  const okState = statesB[statesB.length - 1];
  check(
    "background calls the backend with the uploaded server path",
    callsB.length === 1 &&
      callsB[0].data &&
      callsB[0].data[0] &&
      callsB[0].data[0].path === lastFromOffscreen.serverPath,
    JSON.stringify(callsB)
  );
  check(
    "background pushes the result overlay from the serialised message",
    okState && okState.type === "TRUEBEAT_STATE" &&
      okState.payload.state === "result" &&
      okState.payload.result &&
      okState.payload.result.verdict === "fake",
    JSON.stringify(okState)
  );
}

// ------------------------------------------------ 4. static privacy audit

section("4. static audit — no remote code, no telemetry");
{
  const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf-8"));
  check("manifest v3", manifest.manifest_version === 3);
  check(
    "no remote code in the manifest",
    !JSON.stringify(manifest).includes("http://cdn") &&
      !JSON.stringify(manifest).includes("cdn.jsdelivr") &&
      !JSON.stringify(manifest).includes("unpkg")
  );
  check(
    "host permissions are local-only by default",
    manifest.host_permissions.every((h) =>
      /^https?:\/\/(127\.0\.0\.1|localhost)\/\*$/.test(h)
    ),
    JSON.stringify(manifest.host_permissions)
  );
  check(
    "other origins are optional (asked for at save time)",
    Array.isArray(manifest.optional_host_permissions) &&
      manifest.optional_host_permissions.length > 0
  );

  const files = [
    "background.js",
    "offscreen.js",
    "popup.js",
    "options.js",
    "overlay.js",
  ];
  const telemetryHosts = [
    "google-analytics",
    "googletagmanager",
    "segment.io",
    "sentry.io",
    "amplitude",
    "mixpanel",
    "facebook.com/tr",
    "doubleclick",
  ];
  let hostHits = [];
  let remoteCodeHits = [];
  let inlineScriptHits = [];
  for (const f of files) {
    const src = readFileSync(join(EXT, f), "utf-8");
    for (const h of telemetryHosts) {
      if (src.includes(h)) hostHits.push(`${f}:${h}`);
    }
    // Remote script/style injection
    for (const m of src.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
      const url = m[0];
      if (/cdn|jsdelivr|unpkg|googleapis|cloudflare/i.test(url)) {
        remoteCodeHits.push(`${f}:${url}`);
      }
    }
  }
  for (const f of ["popup.html", "options.html", "offscreen.html"]) {
    const html = readFileSync(join(EXT, f), "utf-8");
    // any <script> without a src= is inline -> blocked by the MV3 CSP
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
      if (!/src=/.test(m[1])) inlineScriptHits.push(f);
    }
    for (const m of html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)) {
      if (/^https?:/.test(m[1])) remoteCodeHits.push(`${f}:${m[1]}`);
    }
  }
  check("no telemetry/analytics hosts referenced", hostHits.length === 0, hostHits.join(", "));
  check(
    "no remote scripts or CDN references",
    remoteCodeHits.length === 0,
    remoteCodeHits.join(", ")
  );
  check(
    "no inline <script> (MV3 CSP would block it)",
    inlineScriptHits.length === 0,
    inlineScriptHits.join(", ")
  );

  // The only fetch targets must be the configured backend.
  const bg = readFileSync(join(EXT, "background.js"), "utf-8");
  const fetches = [...bg.matchAll(/fetch\(\s*([^,\)]+)/g)].map((m) => m[1].trim());
  const badFetch = fetches.filter(
    (u) => !/backend|base|info|url|BASE|origin/i.test(u)
  );
  check(
    "every fetch in background.js targets the configured backend",
    badFetch.length === 0,
    badFetch.join(", ")
  );
  const absFetch = fetches.filter((u) => /https?:\/\//.test(u));
  check(
    "no hard-coded absolute URL in background.js fetches",
    absFetch.length === 0,
    absFetch.join(", ")
  );

  // The 1.0.2 bug guards: the upload lives in the offscreen document.
  const bgSource = readFileSync(join(EXT, "background.js"), "utf-8");
  check(
    "background owns no upload: no FormData in background.js",
    !bgSource.includes("FormData")
  );
  const offSource = readFileSync(join(EXT, "offscreen.js"), "utf-8");
  check(
    "the offscreen document performs the upload (gradio_api/upload)",
    offSource.includes("gradio_api/upload")
  );
}

// --------------------------------------------------------------- a fake backend

section("5. a backend that answers with garbage is not a verdict");
{
  // Spin up a server that mimics the Gradio shape but returns junk.
  const server = createServer((req, res) => {
    if (req.url.endsWith("/gradio_api/info")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ named_endpoints: { "/analyze_video": {} } }));
      return;
    }
    if (req.url.endsWith("/gradio_api/upload")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(["/tmp/fake.mp4"]));
      return;
    }
    if (req.url.includes("/gradio_api/call/analyze_video/")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('event: complete\ndata: ["not json"]\n\n');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ event_id: "abc" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const globals = { chrome: chromeStub(), fetch, FormData, AbortController, console, URL, Blob };
  const analyseOnBackend = loadScript("background.js", globals);
  let out = null;
  let err = null;
  try {
    out = await analyseOnBackend.call(
      { normaliseBackend: (u) => u },
      `http://127.0.0.1:${port}`,
      "/tmp/gradio/fake/fake.webm"
    );
  } catch (e) {
    err = e;
  }
  server.close();
  check(
    "an unreadable backend reply does not become a verdict",
    (out && out.verdict === "inconclusive") || err !== null,
    JSON.stringify(out) + String(err)
  );
}

// ----------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
