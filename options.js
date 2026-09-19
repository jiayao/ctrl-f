const DEFAULTS = { apiKey: "", model: "jev-latest", windowSize: 25, concurrency: 4, defaultMode: "find", defaultCompact: false };
const $ = (id) => document.getElementById(id);

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $("apiKey").value = s.apiKey; $("model").value = s.model;
  $("windowSize").value = s.windowSize; $("concurrency").value = s.concurrency;
  $("defaultMode").value = s.defaultMode === "digest" ? "digest" : "find";
  const { labels = [] } = await chrome.storage.local.get({ labels: [] });
  const yes = labels.filter((l) => l.correct).length;
  $("labelCount").textContent = labels.length
    ? `${labels.length} labels · ${yes} yes · ${labels.length - yes} no`
    : "No labels yet.";
}

$("save").onclick = async () => {
  await chrome.storage.local.set({
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULTS.model,
    windowSize: clamp(parseInt($("windowSize").value, 10) || DEFAULTS.windowSize, 5, 60),
    concurrency: clamp(parseInt($("concurrency").value, 10) || DEFAULTS.concurrency, 1, 8),
    defaultMode: $("defaultMode").value === "digest" ? "digest" : "find",
  });
  $("saved").classList.add("show");
  setTimeout(() => $("saved").classList.remove("show"), 1500);
};

$("export").onclick = async () => {
  const { labels = [] } = await chrome.storage.local.get({ labels: [] });
  const blob = new Blob([JSON.stringify(labels, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "labels.json" });
  a.click(); URL.revokeObjectURL(a.href);
};

$("clear").onclick = async () => {
  if (confirm("Delete all saved labels?")) { await chrome.storage.local.set({ labels: [] }); load(); }
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
load();
