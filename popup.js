const els = {
  input: document.getElementById("inputList"),
  btnDownload: document.getElementById("downloadBtn"),
  btnStop: document.getElementById("stopBtn"),
  statTotal: document.getElementById("statTotal"),
  statCompleted: document.getElementById("statCompleted"),
  statFailed: document.getElementById("statFailed"),
  currentItem: document.getElementById("currentItem"),
  logPanel: document.getElementById("logPanel")
};

// 1. Load initial state
chrome.storage.local.get(['appState'], (result) => {
  if (result.appState) {
    renderUI(result.appState);
  }
});

// 2. Poll for updates (500ms)
setInterval(() => {
  chrome.storage.local.get(['appState'], (result) => {
    if (result.appState) {
      renderUI(result.appState);
    }
  });
}, 500);

// 3. Render UI based on state
function renderUI(state) {
  // Only update input if not focused (to avoid cursor jumping) or if empty
  if (document.activeElement !== els.input) {
    // Check if changed to avoid unnecessary redraws
    if (els.input.value !== state.inputList) {
      els.input.value = state.inputList;
    }
  }

  // Stats
  els.statTotal.textContent = state.stats.total;
  els.statCompleted.textContent = state.stats.completed;
  els.statFailed.textContent = state.stats.failed;
  els.currentItem.textContent = state.isRunning ? `Processing: ${state.stats.currentItem}` : "Ready / Idle";

  // Buttons
  els.btnDownload.disabled = state.isRunning;
  els.btnStop.disabled = !state.isRunning;
  els.btnDownload.textContent = state.isRunning ? "Running..." : "Start Download";

  // Logs
  const logHtml = state.logs.map(l => `<div class="log-entry">${l}</div>`).join('');
  if (els.logPanel.innerHTML !== logHtml) {
    els.logPanel.innerHTML = logHtml;
  }
}

// 4. Event Listeners

// Auto-save input
els.input.addEventListener("keyup", () => {
  chrome.runtime.sendMessage({ action: "UPDATE_INPUT", text: els.input.value });
});

// Start
els.btnDownload.addEventListener("click", () => {
  const raw = els.input.value.trim();
  if (!raw) return;
  const list = raw.split("\n").map(x => x.trim()).filter(x => x.length);
  chrome.runtime.sendMessage({ action: "START_TASK", list });
});

// Stop
els.btnStop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "STOP_TASK" });
});
