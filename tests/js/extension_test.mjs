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

/** A chrome API stub good enough for background.js to load. */
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
      sendMessage: async () => ({}),
      id: "test",
    },
    offscreen: {
      hasDocument: async () => true,
      createDocument: async () => {},
    },
    tabCapture: { getMediaStreamId: async () => "stream-id" },
    tabs: { sendMessage: async () => {}, query: async () => [] },
    scripting: { executeScript: async () => {} },
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
    new Blob([new Uint8Array([1, 2, 3])]),
    "x.webm"
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
        result = await analyseOnBackend.call(
          { normaliseBackend: (u) => u },
          BACKEND,
          new Blob([readFileSync(VIDEO)], { type: "video/mp4" }),
          "test.mp4"
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
      new Blob([new Uint8Array([0])]),
      "x.webm"
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
