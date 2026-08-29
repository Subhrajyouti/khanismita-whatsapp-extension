const DEFAULTS = {
  geminiKey: "",
  model: "gemini-2.5-flash",
  supabaseUrl: "https://opcnbtnoefrchzdaabbt.supabase.co",
  supabaseKey: "",
  lookback: 20,
};

const ids = Object.keys(DEFAULTS);

chrome.storage.local.get(DEFAULTS, (cfg) => {
  ids.forEach((k) => (document.getElementById(k).value = cfg[k] ?? ""));
});

document.getElementById("save").addEventListener("click", () => {
  const out = {};
  ids.forEach((k) => (out[k] = document.getElementById(k).value.trim()));
  out.lookback = Number(out.lookback) || 20;
  chrome.storage.local.set(out, () => {
    document.getElementById("status").textContent = "Saved ✓";
    setTimeout(() => (document.getElementById("status").textContent = ""), 1500);
  });
});

/* ---------------- Menu cache ---------------- */

const send = (type, payload) =>
  new Promise((res) => chrome.runtime.sendMessage({ type, payload }, res));

function formatCacheInfo(cache) {
  const count = cache?.menu?.length || 0;
  if (!cache?.fetchedAt) return 'Menu cache: empty — click "Refresh menu" to load it.';
  const when = new Date(cache.fetchedAt);
  const timeStr = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Menu cache: ${count} item${count === 1 ? "" : "s"} · last refreshed ${timeStr}`;
}

async function loadCacheInfo() {
  const infoEl = document.getElementById("menuCacheInfo");
  const res = await send("GET_MENU_INFO");
  infoEl.textContent = res?.ok ? formatCacheInfo(res.data) : "Menu cache: unavailable";
}

document.getElementById("refreshMenu").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const infoEl = document.getElementById("menuCacheInfo");
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = "Refreshing…";
  infoEl.textContent = "Menu cache: refreshing…";
  const res = await send("REFRESH_MENU");
  btn.disabled = false;
  btn.textContent = prevLabel;
  infoEl.textContent = res?.ok
    ? formatCacheInfo(res.data)
    : `Menu cache: refresh failed — ${res?.error || "unknown error"}`;
});

loadCacheInfo();
