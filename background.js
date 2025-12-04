// --- STATE MANAGEMENT ---

const DEFAULT_STATE = {
  inputList: "",
  isRunning: false,
  shouldStop: false,
  stats: {
    total: 0,
    completed: 0,
    failed: 0,
    currentItem: ""
  },
  logs: []
};

// Initialize state on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['appState'], (result) => {
    if (!result.appState) {
      chrome.storage.local.set({ appState: DEFAULT_STATE });
    }
  });
});

// Helper to update state
async function updateState(updates) {
  const data = await chrome.storage.local.get('appState');
  const newState = { ...DEFAULT_STATE, ...data.appState, ...updates };
  await chrome.storage.local.set({ appState: newState });
  return newState;
}

// Helper to add log
async function addLog(message) {
  const data = await chrome.storage.local.get('appState');
  const logs = data.appState?.logs || [];
  logs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
  if (logs.length > 50) logs.pop(); // Keep last 50
  await updateState({ logs });
}

// --- SCRAPING LOGIC ---

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (tid, changeInfo) => {
      if (tid === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function extractImageFromPage() {
  console.log("Scraper: Script injected.");
  const waitFor = (ms) => new Promise(r => setTimeout(r, ms));
  const maxAttempts = 20;

  // Scroll to trigger lazy loading
  window.scrollTo(0, 500);

  for (let i = 0; i < maxAttempts; i++) {
    if (document.body.innerText.includes("Before you continue to Google")) {
      return "CONSENT_BLOCK";
    }

    // 1. Try to find the high-res URL in the page source (legacy "ou" key)
    const html = document.documentElement.innerHTML;
    const match = html.match(/"ou":"(https?:\/\/[^"]+)"/);
    if (match) return match[1];

    // 2. Try to find the first image in the main results grid (if present)
    const gridImage = document.querySelector('#islrg img');
    if (gridImage && gridImage.src && gridImage.src.startsWith('http')) return gridImage.src;

    // 3. Fallback: Try standard thumbnail class .rg_i (if present)
    const thumb = document.querySelector('img.rg_i');
    if (thumb && thumb.src && thumb.src.startsWith('http')) return thumb.src;

    // 4. Fallback: Look for any image that is "large enough" (likely a result)
    // This is the most reliable method when specific classes change
    const images = document.querySelectorAll('img');
    for (const img of images) {
      // Must be http(s) and reasonably large (avoid icons)
      if (img.src.startsWith('http') && img.width > 100 && img.height > 100) {
        if (img.src.includes('google')) continue; // Skip logo
        return img.src;
      }
    }
    await waitFor(250);
  }
  return null;
}

async function processQueue() {
  let data = await chrome.storage.local.get('appState');
  let state = data.appState;

  if (!state.isRunning) return;

  const lines = state.inputList.split('\n').map(x => x.trim()).filter(x => x);
  // We assume the UI sets stats.total before starting

  // Find where we left off or start fresh? 
  // For simplicity, we'll just process the whole list, but check if we should stop.
  // A better approach for "Resume" would be to track index. 
  // Here we will just iterate and check stats.completed + stats.failed to skip?
  // No, let's just process the list. The user can edit the list if they want to resume specifically.

  for (const query of lines) {
    // Refresh state to check for stop flag
    data = await chrome.storage.local.get('appState');
    if (data.appState.shouldStop) {
      await addLog("Process stopped by user.");
      break;
    }

    await updateState({
      stats: { ...data.appState.stats, currentItem: query }
    });

    try {
      await addLog(`Processing: ${query}`);

      // Scrape
      const searchUrl = "https://www.google.com/search?tbm=isch&q=" + encodeURIComponent(query + " photo");

      // IMPORTANT: Create tab as ACTIVE to ensure rendering/loading
      const tab = await chrome.tabs.create({ url: searchUrl, active: true });

      const loadPromise = waitForTabLoad(tab.id);
      const timeoutPromise = new Promise(r => setTimeout(r, 10000));
      await Promise.race([loadPromise, timeoutPromise]);

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractImageFromPage,
      });

      const imageUrl = results[0]?.result;
      chrome.tabs.remove(tab.id);

      if (imageUrl && imageUrl !== "CONSENT_BLOCK") {
        const safeName = query.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        await chrome.downloads.download({
          url: imageUrl,
          filename: "scraped_images/" + safeName + ".jpg"
        });

        // Update stats
        data = await chrome.storage.local.get('appState');
        await updateState({
          stats: { ...data.appState.stats, completed: data.appState.stats.completed + 1 }
        });
        await addLog(`Downloaded: ${query}`);
      } else {
        // Failed
        data = await chrome.storage.local.get('appState');
        await updateState({
          stats: { ...data.appState.stats, failed: data.appState.stats.failed + 1 }
        });
        await addLog(`Failed (No image): ${query}`);
      }

    } catch (err) {
      console.error(err);
      data = await chrome.storage.local.get('appState');
      await updateState({
        stats: { ...data.appState.stats, failed: data.appState.stats.failed + 1 }
      });
      await addLog(`Error: ${query} - ${err.message}`);
    }

    // Wait a bit
    await new Promise(r => setTimeout(r, 1000));
  }

  await updateState({ isRunning: false, shouldStop: false });
  await addLog("Task finished.");
}

// --- MESSAGE LISTENER ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "START_TASK") {
    (async () => {
      const lines = msg.list;
      await updateState({
        inputList: lines.join('\n'),
        isRunning: true,
        shouldStop: false,
        stats: {
          total: lines.length,
          completed: 0,
          failed: 0,
          currentItem: "Starting..."
        },
        logs: []
      });
      await addLog("Task started.");
      processQueue();
    })();
  } else if (msg.action === "STOP_TASK") {
    updateState({ shouldStop: true });
    addLog("Stopping...");
  } else if (msg.action === "UPDATE_INPUT") {
    updateState({ inputList: msg.text });
  }
});
