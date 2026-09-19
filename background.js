// Jev Find — background service worker.
// Two jobs: put the find bar on the current tab, and make the API calls
// (content scripts can't reach api.typesafe.ai directly; the worker can,
// via host_permissions).

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULTS = { apiKey: "", model: "jev-latest", windowSize: 25, concurrency: 4, defaultMode: "find" };

async function settings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

async function openBar(tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
  } catch (e) {
    console.warn("Jev Find: could not open on this page", e);
  }
}

chrome.action.onClicked.addListener(openBar);
chrome.commands.onCommand.addListener((cmd, tab) => { if (cmd === "toggle-find") openBar(tab); });

// One request = one window of the page. Find asks one Noul per sentence;
// Digest asks a relevance Noul and semantic-role Choice per passage.
async function judge({ state, questions }) {
  const { apiKey, model } = await settings();
  if (!apiKey) return { error: "no_key" };
  const body = JSON.stringify({ model, state, questions });
  let delay = 600;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45000);
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body, signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (attempt === 3) return { error: `network: ${e.message}` };
      await sleep(delay); delay *= 2; continue;
    }
    clearTimeout(timer);
    if (res.status === 429 || res.status === 529) { await sleep(delay); delay *= 2; continue; }
    if (res.status === 401) return { error: "bad_key" };
    if (!res.ok) return { error: `${res.status}: ${(await res.text()).slice(0, 300)}` };
    const data = await res.json();
    return { answers: data.answers, usage: data.usage, model: data.model };
  }
  return { error: "rate_limited" };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "judge") { judge(msg).then(reply, (e) => reply({ error: String(e) })); return true; }
  if (msg.type === "settings") { settings().then(reply); return true; }
  if (msg.type === "label") {
    chrome.storage.local.get({ labels: [] }).then(({ labels }) => {
      labels.push(msg.label);
      return chrome.storage.local.set({ labels });
    }).then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === "openOptions") { chrome.runtime.openOptionsPage(); reply({ ok: true }); return false; }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
