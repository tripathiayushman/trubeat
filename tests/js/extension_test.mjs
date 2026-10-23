/**
 * Automated tests for the TrueBeat browser extension.
 *
 * These load the *shipped* extension files (not copies) and exercise the
 * real code paths:
 *   1. offscreen.js — the backend client (upload -> call -> SSE with
 *      reconnect-resume, 1.0.3) against a live `trubeat serve`, plus the
 *      backend-unreachable path;
 *   2. overlay.js — the verdict -> colour/copy mapping and the standing
 *      caveat wording;
 *   3. offscreen.js — the recorder: black-frame guard, tab-capture wiring,
 *      the whole bus from CAPTURE_UPLOADED to the result overlay, and the
 *      analysis wait itself (retries, honest final error);
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
  const fn = new Function(...Object.keys(globals), `${src}\n;`);
  return fn(...Object.values(globals));
}

// -------------------------------------------- 1. the backend client (ANALYZE)

section("1. offscreen.js — the backend client (ANALYZE against a backend)");
{
  // Since 1.0.3 the whole backend conversation lives in the offscreen
  // document (background.js only relays). The tests drive the shipped
  // ANALYZE handler directly and read what it posts to the runtime.
  const listeners = [];
  const sent = [];
  const trackStub = {
    addEventListener: () => {},
    getSettings: () => ({ width: 640, height: 360 }),
  };
  const streamStub = { getVideoTracks: () => [trackStub], getTracks: () => [] };
  const RecorderStub = function () {};
  RecorderStub.isTypeSupported = () => true;

  loadScript("offscreen.js", {
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
    navigator: { mediaDevices: { getUserMedia: async () => streamStub } },
    window: { MediaRecorder: RecorderStub },
    MediaRecorder: RecorderStub,
    document: { createElement: () => ({ getContext: () => null }) },
    setInterval: () => 0,
    setTimeout: (fn) => (fn(), 0), // collapse the reconnect waits
    clearInterval: () => {},
    clearTimeout: () => {},
    fetch, // the real fetch: a dead backend first, a live one further down
    FormData,
    Blob,
    TextDecoder,
    console,
  });

  // Run one analysis and return the message it posted to the runtime.
  const analyse = async (serverPath, backendUrl, capMs = 540000) => {
    const before = sent.length;
    const startedAt = Date.now();
    listeners[0](
      { type: "ANALYZE", tabId: 7, serverPath, backend: backendUrl },
      null,
      () => {}
    );
    for (;;) {
      if (sent.length > before) return sent[sent.length - 1];
      if (Date.now() - startedAt > capMs) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  // Backend unreachable -> an honest error, never a fabricated verdict.
  const posted = await analyse(
    "/tmp/gradio/truebeat/dead/dead.webm",
    "http://127.0.0.1:9"
  );
  check(
    "unreachable backend posts a readable backend error",
    posted &&
      posted.type === "CAPTURE_ERROR" &&
      /unreachable|HTTP|refused|fetch failed|ECONNREFUSED/i.test(
        posted.message || ""
      ),
    JSON.stringify(posted)
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
      let apiResult = null;
      let liveError = null;
      try {
        // The harness uploads exactly like the extension's offscreen
        // document, then analyses the server-side copy through ANALYZE.
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
        apiResult = await analyse(path, BACKEND);
      } catch (e) {
        liveError = e;
      }
      const result =
        apiResult && apiResult.type === "ANALYSIS_RESULT"
          ? apiResult.result
          : null;
      const postedError =
        apiResult && apiResult.type === "CAPTURE_ERROR"
          ? apiResult.message
          : null;
      if (liveError || postedError || !result) {
        check(
          "live backend returns a verdict",
          false,
          "backend error: " +
            String(
              (liveError && liveError.message) || postedError || "no result"
            ).slice(0, 200)
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

// ---------------------------------------------- 3c. capture -> verdict bus

section("3c. capture -> upload -> ANALYZE -> result (the whole bus)");
{
  // The two reported bugs, modelled together. The bus mimics the browser:
  // every runtime post is JSON-serialised and handed to every registered
  // listener (background's own echo is honestly harmless — neither script
  // has a case for the other's request types).
  //   1. a recorded Blob must never cross the runtime (it would arrive in
  //      background.js as {}), so the offscreen document uploads;
  //   2. the analysis wait lives in the offscreen document too: background
  //      hands over the server path (ANALYZE) and relays the verdict
  //      (ANALYSIS_RESULT) — an idle SSE stream would be dropped by the
  //      service worker's ~30 s idle leash.

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

  const listeners = []; // every registered listener, both documents
  const overlays = []; // TRUEBEAT_STATE traffic into the content script
  const deliveries = []; // everything that crossed the runtime
  const fetchLog = []; // backend traffic from the offscreen document
  const settings = { backend: "http://127.0.0.1:9", captureSeconds: 20 };
  const verdict = {
    verdict: "fake",
    headline: "Pulse inconsistent: pixel-replacement pattern detected",
    score: 0.91,
    caveat: "Detects face-swap-style fakes: reenactment fakes keep the pulse.",
  };

  const bus = chromeStub({
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (m) => {
        const delivered = rtMessage(m);
        deliveries.push(delivered);
        for (const fn of [...listeners]) {
          try {
            fn(delivered, null, () => {});
          } catch (_) {
            /* one broken handler never kills the bus */
          }
        }
        return {};
      },
      id: "test",
    },
    tabs: {
      sendMessage: async (_tab, m) => {
        overlays.push(rtMessage(m));
        return {};
      },
      query: async () => [],
    },
    storage: {
      local: {
        get: async (keys) => ({ ...keys, ...settings }),
        set: async (o) => Object.assign(settings, o),
      },
    },
  });

  const fetchStub = async (url, opts) => {
    const u = String(url);
    fetchLog.push({
      url: u,
      body: opts && opts.body,
      method: (opts && opts.method) || "GET",
    });
    if (u.endsWith("/gradio_api/upload")) {
      return {
        ok: true,
        status: 200,
        json: async () => ["/tmp/gradio/truebeat/uploads/cap.webm"],
      };
    }
    if (u.endsWith("/gradio_api/info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ named_endpoints: { "/analyze_video": {} } }),
      };
    }
    if (u.endsWith("/gradio_api/call/analyze_video")) {
      return { ok: true, status: 200, json: async () => ({ event_id: "ev-1" }) };
    }
    if (u.includes("/gradio_api/call/analyze_video/")) {
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            let tick = 0;
            return {
              read: async () => {
                if (tick++ === 0) {
                  return {
                    done: false,
                    value: new TextEncoder().encode(
                      `event: complete\ndata: ${JSON.stringify([JSON.stringify(verdict)])}\n\n`
                    ),
                  };
                }
                return { done: true };
              },
            };
          },
        },
      };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };

  const scriptGlobals = (navigator) => ({
    chrome: bus,
    fetch: fetchStub,
    FormData,
    Blob,
    TextDecoder,
    TextEncoder,
    console,
    navigator,
    window: { MediaRecorder: RecorderStub },
    MediaRecorder: RecorderStub,
    document: { createElement: () => ({ getContext: () => null }) },
    setInterval: () => 0,
    setTimeout: (fn) => (fn(), 0), // collapse timers; waits settle at once
    clearInterval: () => {},
    clearTimeout: () => {},
  });

  loadScript(
    "offscreen.js",
    scriptGlobals({ mediaDevices: { getUserMedia: async () => streamStub } })
  );
  loadScript("background.js", scriptGlobals(undefined));

  const dispatch = (m) => {
    const d = rtMessage(m);
    deliveries.push(d);
    for (const fn of [...listeners]) {
      try {
        fn(d, null, () => {});
      } catch (_) {
        /* same tolerance as the bus */
      }
    }
  };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  // The 1.0.2 bug, modelled straight: a message whose Blob serialised to {}.
  {
    overlays.length = 0;
    fetchLog.length = 0;
    dispatch({ type: "CAPTURE_UPLOADED", tabId: 7, blob: {}, filename: "x.webm" });
    await settle(60);
    const badState = overlays[overlays.length - 1];
    check(
      "an unusable server path pushes a readable backend error",
      badState && badState.type === "TRUEBEAT_STATE" &&
        badState.payload.state === "error" &&
        badState.payload.title === "Backend error",
      JSON.stringify(badState)
    );
    check(
      "no backend traffic was generated for the unusable path",
      fetchLog.length === 0,
      JSON.stringify(fetchLog.map((f) => f.url))
    );
  }

  // The fixed pipeline, end to end on the bus: record -> upload -> path ->
  // ANALYZE -> SSE -> ANALYSIS_RESULT -> result overlay.
  {
    overlays.length = 0;
    fetchLog.length = 0;
    deliveries.length = 0;
    dispatch({
      type: "OFFSCREEN_START",
      streamId: "sid-123",
      tabId: 7,
      seconds: 20,
      backend: settings.backend,
    });
    await settle(50);
    recorderInstance.ondataavailable({
      data: new Blob([new Uint8Array(96).fill(7)], { type: "video/webm" }),
    });
    recorderInstance.onstop();
    const startedAt = Date.now();
    let final = null;
    for (;;) {
      final = overlays[overlays.length - 1] || null;
      if (
        final &&
        final.payload &&
        (final.payload.state === "result" || final.payload.state === "error")
      ) {
        break;
      }
      if (Date.now() - startedAt > 10000) break;
      await settle(50);
    }
    check(
      "the overlay was told the analysis is running before any verdict",
      overlays.some((m) => m.payload && m.payload.state === "analyzing"),
      JSON.stringify(overlays.map((m) => m.payload && m.payload.state))
    );
    check(
      "the analysis call used the uploaded server path",
      fetchLog.some(
        (f) =>
          f.url === "http://127.0.0.1:9/gradio_api/call/analyze_video" &&
          typeof f.body === "string" &&
          JSON.parse(f.body).data[0].path ===
            "/tmp/gradio/truebeat/uploads/cap.webm"
      ),
      JSON.stringify(fetchLog.map((f) => f.url))
    );
    check(
      "background relays the posted result into the overlay",
      final &&
        final.type === "TRUEBEAT_STATE" &&
        final.payload.state === "result" &&
        final.payload.result &&
        final.payload.result.verdict === "fake",
      JSON.stringify(final)
    );
    check(
      "no blob ever crossed the runtime",
      deliveries.every((d) => !("blob" in d)) &&
        deliveries.some(
          (d) => d.type === "CAPTURE_UPLOADED" && typeof d.serverPath === "string"
        ) &&
        deliveries.some((d) => d.type === "ANALYZE") &&
        deliveries.some((d) => d.type === "ANALYSIS_RESULT"),
      JSON.stringify(deliveries.map((d) => ({ type: d.type, keys: Object.keys(d) })))
    );
  }
}

// ---------------------------------------------- 3d. the analysis wait (1.0.3)

section("3d. offscreen.js — analysis wait with reconnect-resume");
{
  // The 1.0.3 bug: the SSE wait ran in background.js, a service worker.
  // A mid-analysis drop surfaced Chrome's raw "network error". Now the
  // wait runs in the offscreen document and re-GETs the same event URL
  // (Gradio replays the output of a completed event); a retry success and
  // an honest final error are modelled below.

  const fakeOffscreenContext = (sseBehaviour) => {
    const listeners = [];
    const sent = [];
    const sseCalls = [];
    const verdict = {
      verdict: "fake",
      headline: "Pulse inconsistent: pixel-replacement pattern detected",
      score: 0.91,
      caveat: "Detects face-swap-style fakes: reenactment fakes keep the pulse.",
    };
    loadScript("offscreen.js", {
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
      fetch: async (url, opts) => {
        const u = String(url);
        if (u.endsWith("/gradio_api/info")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ named_endpoints: { "/analyze_video": {} } }),
          };
        }
        if (u.endsWith("/gradio_api/call/analyze_video")) {
          return { ok: true, status: 200, json: async () => ({ event_id: "ev-1" }) };
        }
        if (u.includes("/gradio_api/call/analyze_video/")) {
          sseCalls.push(u);
          return sseBehaviour(sseCalls.length, verdict);
        }
        return { ok: false, status: 500, json: async () => ({}) };
      },
      navigator: {},
      window: { MediaRecorder: undefined },
      document: { createElement: () => ({ getContext: () => null }) },
      setInterval: () => 0,
      setTimeout: (fn) => (fn(), 0), // collapse the 1.5 s reconnect waits
      clearInterval: () => {},
      clearTimeout: () => {},
      FormData,
      Blob,
      TextDecoder,
      TextEncoder,
      console,
    });
    return { listeners, sent, sseCalls };
  };

  const startAnalyze = async (ctx) => {
    const before = ctx.sent.length;
    const startedAt = Date.now();
    ctx.listeners[0](
      {
        type: "ANALYZE",
        tabId: 7,
        serverPath: "/tmp/gradio/truebeat/uploads/cap.webm",
        backend: "http://127.0.0.1:9",
      },
      null,
      () => {}
    );
    for (;;) {
      if (ctx.sent.length > before) return ctx.sent[ctx.sent.length - 1];
      if (Date.now() - startedAt > 5000) return null;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  // (a) attempt 1 dies mid-stream; attempt 2 replays the whole event.
  {
    const ctx = fakeOffscreenContext((attempt, verdict) => {
      if (attempt === 1) {
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => {
                throw new TypeError("network error");
              },
            }),
          },
        };
      }
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            let tick = 0;
            return {
              read: async () => {
                if (tick++ === 0) {
                  return {
                    done: false,
                    value: new TextEncoder().encode(
                      `event: complete\ndata: ${JSON.stringify([JSON.stringify(verdict)])}\n\n`
                    ),
                  };
                }
                return { done: true };
              },
            };
          },
        },
      };
    });
    const posted = await startAnalyze(ctx);
    check(
      "a dropped stream is retried and the verdict arrives",
      posted &&
        posted.type === "ANALYSIS_RESULT" &&
        posted.result &&
        posted.result.verdict === "fake" &&
        posted.tabId === 7,
      JSON.stringify(posted)
    );
    check(
      "the retry re-GETs the exact same event URL",
      ctx.sseCalls.length === 2 && ctx.sseCalls[0] === ctx.sseCalls[1],
      JSON.stringify(ctx.sseCalls)
    );
  }

  // (b) every attempt is refused; the retries run out with a readable,
  // honest message — never Chrome's raw error text.
  {
    const ctx = fakeOffscreenContext(() => ({ ok: false, status: 503 }));
    const posted = await startAnalyze(ctx);
    check(
      "retries exhausted produce the readable drop message",
      posted &&
        posted.type === "CAPTURE_ERROR" &&
        posted.title === "Backend error" &&
        posted.message ===
          "The connection to your backend dropped while analysing (retried 12 times). Is `trubeat serve` still running?",
      JSON.stringify(posted)
    );
    check(
      "the readable message never carries the raw network error text",
      posted && !/network error/i.test(posted.message || ""),
      posted && posted.message
    );
  }

  // (c) the backend explicitly reports an error on the stream: surfaced
  // verbatim, not retried.
  {
    const ctx = fakeOffscreenContext(() => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => ({
            done: false,
            value: new TextEncoder().encode(
              'data: {"error": "analysis blew up"}\n\n'
            ),
          }),
        }),
      },
    }));
    const posted = await startAnalyze(ctx);
    check(
      "an explicit backend error surfaces its own readable message",
      posted &&
        posted.type === "CAPTURE_ERROR" &&
        /Backend error: "analysis blew up"/.test(posted.message || ""),
      JSON.stringify(posted)
    );
    check(
      "an explicit backend error is not retried",
      ctx.sseCalls.length === 1,
      String(ctx.sseCalls.length)
    );
  }

  // (d) background relays the posted result into the overlay.
  {
    const listenersB = [];
    const statesB = [];
    loadScript("background.js", {
      chrome: chromeStub({
        runtime: {
          onMessage: { addListener: (fn) => listenersB.push(fn) },
          sendMessage: async () => ({}),
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
      fetch,
      console,
    });
    listenersB[0](
      {
        type: "ANALYSIS_RESULT",
        tabId: 7,
        result: { verdict: "real", headline: "Pulse consistent: likely real", score: 0.2 },
      },
      null,
      () => {}
    );
    await new Promise((r) => setTimeout(r, 40));
    const last = statesB[statesB.length - 1];
    check(
      "background relays ANALYSIS_RESULT into the result overlay",
      last &&
        last.type === "TRUEBEAT_STATE" &&
        last.payload.state === "result" &&
        last.payload.result &&
        last.payload.result.verdict === "real",
      JSON.stringify(last)
    );
  }
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

  // The 1.0.3 guards: the SSE wait lives in the offscreen document.
  check(
    "no SSE reader is left behind in background.js (no getReader)",
    !bgSource.includes("getReader")
  );
  check(
    "no call endpoints left in background.js (the offscreen doc owns them)",
    !bgSource.includes("/gradio_api/call")
  );
  check(
    "the offscreen document owns the ANALYZE handler",
    offSource.includes('msg.type === "ANALYZE"')
  );
  check(
    "the offscreen document owns the reconnect-resume loop",
    offSource.includes("SSE_RETRIES")
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

  // The conversation moved to the offscreen document in 1.0.3 (a service
  // worker would be idle-killed mid-stream): drive the shipped ANALYZE
  // handler against the junk backend.
  const listeners = [];
  const sent = [];
  loadScript("offscreen.js", {
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
    fetch,
    navigator: {},
    window: { MediaRecorder: undefined },
    document: { createElement: () => ({ getContext: () => null }) },
    setInterval: () => 0,
    setTimeout: (fn) => (fn(), 0), // collapse the reconnect waits
    clearInterval: () => {},
    clearTimeout: () => {},
    FormData,
    Blob,
    TextDecoder,
    console,
  });

  listeners[0](
    {
      type: "ANALYZE",
      tabId: 7,
      serverPath: "/tmp/gradio/fake/fake.webm",
      backend: `http://127.0.0.1:${port}`,
    },
    null,
    () => {}
  );
  const startedAt = Date.now();
  let posted = null;
  for (;;) {
    if (sent.length) {
      posted = sent[sent.length - 1];
      break;
    }
    if (Date.now() - startedAt > 5000) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  server.close();
  check(
    "an unreadable backend reply becomes the honest inconclusive verdict",
    posted &&
      posted.type === "ANALYSIS_RESULT" &&
      posted.result &&
      posted.result.verdict === "inconclusive" &&
      posted.result.headline === "Unreadable backend reply",
    JSON.stringify(posted)
  );
}

// ----------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
