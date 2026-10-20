/**
 * TrueBeat extension — in-page result panel.
 *
 * A shadow-DOM panel in the bottom-right corner. It renders whatever the
 * service worker sends it:
 *   capturing | analyzing | result | error
 *
 * It never computes a verdict: the numbers come from the backend, and the
 * wording matches the app and the website exactly.
 */

(() => {
  if (window.__trueBeatOverlay) return;
  window.__trueBeatOverlay = true;

  const VERDICT_STYLE = {
    real: {
      accent: "#22c55e",
      label: "Pulse consistent — likely real",
    },
    fake: {
      accent: "#ef4444",
      label: "Pulse inconsistent — pixel-replacement pattern",
    },
    inconclusive: {
      accent: "#f59e0b",
      label: "Inconclusive",
    },
  };

  const STANDING_CAVEAT =
    "Detects face-swaps. Reenactment fakes — Face2Face, NeuralTextures — " +
    "keep the original pulse and are out of scope.";

  // Exposed for the automated tests (tests/js/extension_test.mjs).
  globalThis.__trueBeatVerdictStyles = VERDICT_STYLE;
  globalThis.__trueBeatStandingCaveat = STANDING_CAVEAT;

  let host = null;
  let root = null;
  let panel = null;

  function ensurePanel() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = "truebeat-overlay-host";
    host.style.cssText =
      "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .panel {
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #e6e6e6; background: #14161a; border: 1px solid #2a2e36;
        border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.45);
        width: 320px; padding: 14px 16px; box-sizing: border-box;
      }
      .head { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
      .dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
      .title { font-weight:600; font-size:14px; }
      .close { margin-left:auto; background:none; border:0; color:#8b93a1;
               font-size:17px; line-height:1; cursor:pointer; padding:2px 4px; }
      .close:hover { color:#e6e6e6; }
      .msg { color:#b9c0cc; }
      .bar { height:4px; background:#242832; border-radius:2px; margin:10px 0 4px; overflow:hidden; }
      .bar > i { display:block; height:100%; background:#f97316; width:0%; transition:width .25s; }
      .timer { font-variant-numeric: tabular-nums; color:#8b93a1; font-size:12px; }
      table { width:100%; border-collapse:collapse; margin:10px 0 0; }
      td { padding:2px 0; vertical-align:top; }
      td.k { color:#8b93a1; padding-right:10px; white-space:nowrap; }
      td.v { text-align:right; font-variant-numeric: tabular-nums; }
      .caveat { margin-top:10px; padding-top:8px; border-top:1px solid #262a33;
                color:#8b93a1; font-size:11px; line-height:1.4; }
      .detail { color:#9aa3b2; font-size:12px; margin-top:8px; }
    `;
    panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="head">
        <span class="dot" style="background:#f97316"></span>
        <span class="title">TrueBeat</span>
        <button class="close" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="body"></div>
    `;
    panel.querySelector(".close").addEventListener("click", () => {
      host.remove();
      host = null;
    });
    root.append(style, panel);
    (document.body || document.documentElement).appendChild(host);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function num(v, digits = 1) {
    if (v == null || !isFinite(v)) return "n/a";
    return Number(v).toFixed(digits);
  }

  function render(payload) {
    ensurePanel();
    const body = panel.querySelector(".body");
    const dot = panel.querySelector(".dot");
    const title = panel.querySelector(".title");

    if (payload.state === "capturing") {
      dot.style.background = "#f97316";
      title.textContent = "TrueBeat";
      const elapsed = Math.round(payload.elapsed || 0);
      const total = Math.round(payload.total || 0);
      const pct = total ? Math.min(100, (elapsed / total) * 100) : 0;
      body.innerHTML = `
        <div class="msg">Capturing… ${elapsed}s${total ? " / " + total + "s" : ""}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="timer">${esc(payload.message || "Recording the tab…")}</div>`;
      return;
    }

    if (payload.state === "analyzing") {
      dot.style.background = "#f97316";
      title.textContent = "TrueBeat";
      body.innerHTML = `
        <div class="msg">${esc(payload.message || "Analysing…")}</div>
        <div class="bar"><i style="width:100%"></i></div>`;
      return;
    }

    if (payload.state === "error") {
      dot.style.background = "#f59e0b";
      title.textContent = payload.title || "TrueBeat";
      body.innerHTML = `
        <div class="msg">${esc(payload.message || "")}</div>`;
      return;
    }

    if (payload.state === "result") {
      const r = payload.result || {};
      const style = VERDICT_STYLE[r.verdict] || VERDICT_STYLE.inconclusive;
      dot.style.background = style.accent;
      title.textContent = "TrueBeat";
      const rows = [];
      if (r.hr_bpm != null) {
        rows.push(["heart rate", num(r.hr_bpm) + " bpm"]);
      }
      if (r.region_agreement_bpm != null) {
        rows.push([
          "region agreement",
          num(r.region_agreement_bpm) + " bpm spread",
        ]);
      }
      if (r.snr != null) {
        rows.push(["SNR", num(r.snr)]);
      }
      if (r.face_valid_frac != null) {
        rows.push(["face visible", Math.round(r.face_valid_frac * 100) + "%"]);
      }
      if (r.score != null) {
        rows.push(["score", num(r.score, 3)]);
      }
      body.innerHTML = `
        <div class="msg" style="color:${style.accent};font-weight:600">
          ${esc(r.headline || style.label)}
        </div>
        ${r.detail ? `<div class="detail">${esc(r.detail)}</div>` : ""}
        ${
          rows.length
            ? `<table>${rows
                .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`)
                .join("")}</table>`
            : ""
        }
        <div class="caveat">${esc(r.caveat || STANDING_CAVEAT)}</div>`;
      return;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "TRUEBEAT_STATE") {
      render(msg.payload || {});
    }
  });
})();
