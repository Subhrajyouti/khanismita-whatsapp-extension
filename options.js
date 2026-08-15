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
