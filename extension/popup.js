/**
 * TrueBeat extension — popup.
 *
 * One button ("Check this tab"), a backend status dot, and a link to the
 * options page. The popup never analyses anything itself.
 */

const dot = document.getElementById("dot");
const backendLabel = document.getElementById("backend");
const status = document.getElementById("status");
const checkBtn = document.getElementById("check");
const optionsBtn = document.getElementById("options");

async function refreshStatus() {
  try {
    const s = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    backendLabel.textContent = s.backend;
    if (s.reachable) {
      dot.className = "dot ok";
      status.textContent = s.hasAnalyze
        ? "Backend ready."
        : "Backend reachable, but it has no analyze_video endpoint.";
      status.className = "status";
    } else {
      dot.className = "dot bad";
      status.textContent = "Backend unreachable. Start it with: trubeat serve";
      status.className = "status err";
    }
  } catch (err) {
    dot.className = "dot bad";
    status.textContent = "Backend unreachable. Start it with: trubeat serve";
    status.className = "status err";
  }
}

checkBtn.addEventListener("click", async () => {
  checkBtn.disabled = true;
  status.className = "status";
  status.textContent = "Capturing the tab…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab.");
    await chrome.runtime.sendMessage({ type: "CHECK_TAB", tabId: tab.id });
    status.textContent = "Capturing: the result appears on the page.";
    // Give the capture a moment, then let the user get back to the page.
    setTimeout(() => window.close(), 600);
  } catch (err) {
    status.textContent = "Could not start: " + String(err && err.message);
    status.className = "status err";
    checkBtn.disabled = false;
  }
});

optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refreshStatus();
