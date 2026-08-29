// Service worker: Gemini parsing + Supabase draft writes.

const DEFAULTS = {
  geminiKey: "",
  model: "gemini-2.5-flash",
  supabaseUrl: "https://opcnbtnoefrchzdaabbt.supabase.co",
  supabaseKey: "",
  lookback: 20,
};

function cfg() {
  return new Promise((res) => chrome.storage.local.get(DEFAULTS, res));
}

async function sb(path, { method = "GET", body, prefer } = {}) {
  const c = await cfg();
  if (!c.supabaseUrl || !c.supabaseKey) throw new Error("Supabase URL / anon key missing in extension settings.");
  const r = await fetch(`${c.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: c.supabaseKey,
      Authorization: `Bearer ${c.supabaseKey}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * ---------------- Menu cache ----------------
 *
 * The menu (with prices) is now kept entirely OUT of the Gemini prompt — parseChat
 * only ever sees the raw conversation text. Matching a transcribed item name back to
 * a real menu row + price happens locally in content.js (resolveItems), using this
 * cache. This module is only responsible for keeping that cache fresh cheaply:
 * check a version hash (cheap) before pulling a full snapshot (less cheap).
 */

const MENU_CACHE_KEY = "menuCache";
const MENU_CACHE_TTL_MS = 5 * 60 * 1000;
const EMPTY_MENU_CACHE = { menu: [], menuVersion: null, fetchedAt: 0 };

function readMenuCache() {
  return new Promise((res) => chrome.storage.local.get({ [MENU_CACHE_KEY]: EMPTY_MENU_CACHE }, (r) => res(r[MENU_CACHE_KEY])));
}
function writeMenuCache(cache) {
  return new Promise((res) => chrome.storage.local.set({ [MENU_CACHE_KEY]: cache }, res));
}
function clearMenuCache() {
  return new Promise((res) => chrome.storage.local.remove(MENU_CACHE_KEY, res));
}

async function sbRpc(fnName) {
  const c = await cfg();
  if (!c.supabaseUrl || !c.supabaseKey) throw new Error("Supabase URL / anon key missing in extension settings.");
  const r = await fetch(`${c.supabaseUrl}/rest/v1/rpc/${fnName}`, {
    method: "POST",
    headers: {
      apikey: c.supabaseKey,
      Authorization: `Bearer ${c.supabaseKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase RPC ${fnName} ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// RPC results can come back as a bare scalar ("abc123"), a single-row object
// ({hash: "abc123"}), or a one-row array wrapping either — handle all three so a
// harmless PostgREST return-shape difference never breaks the cache.
function extractHash(result) {
  if (result == null) return null;
  if (typeof result === "string" || typeof result === "number") return String(result);
  if (Array.isArray(result)) {
    const first = result[0];
    if (first == null) return null;
    if (typeof first === "string" || typeof first === "number") return String(first);
    return first.hash != null ? String(first.hash) : null;
  }
  if (typeof result === "object") return result.hash != null ? String(result.hash) : null;
  return null;
}

function extractRows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}

/**
 * Returns { menu, menuVersion, fetchedAt }.
 * - Fresh cache (< 5 min old) and not forced: return it as-is.
 * - Otherwise: cheap version check first. Hash unchanged -> just bump fetchedAt and
 *   return the existing rows. Hash changed (or no cache yet) -> pull a full snapshot
 *   and store the new rows against the new hash.
 */
async function getMenuCached({ force = false } = {}) {
  const cache = (await readMenuCache()) || EMPTY_MENU_CACHE;
  const age = Date.now() - (cache.fetchedAt || 0);

  if (!force && cache.fetchedAt && age < MENU_CACHE_TTL_MS) {
    return cache;
  }

  const newVersion = extractHash(await sbRpc("extension_menu_version"));

  if (!force && newVersion && cache.menuVersion && newVersion === cache.menuVersion) {
    const refreshed = { ...cache, fetchedAt: Date.now() };
    await writeMenuCache(refreshed);
    return refreshed;
  }

  const rows = extractRows(await sbRpc("extension_menu_snapshot"));
  const fresh = { menu: rows, menuVersion: newVersion, fetchedAt: Date.now() };
  await writeMenuCache(fresh);
  return fresh;
}

async function refreshMenu() {
  await clearMenuCache();
  return getMenuCached({ force: true });
}

async function parseChat({ transcript }) {
  const c = await cfg();
  if (!c.geminiKey) throw new Error("Gemini API key missing in extension settings.");

  const prompt = `You transcribe food delivery orders from a WhatsApp conversation for an Indian restaurant.

You are NOT given the restaurant's menu or prices. Matching item names to the real menu and pricing happens later, locally, outside this step — your only job is to faithfully transcribe what the customer said.

CONVERSATION (most recent messages, oldest first):
${transcript}

Rules:
- Only use the LATEST order intent in the conversation. Ignore older/completed orders.
- For every item ordered, copy the item name into raw_name EXACTLY as the customer typed it — do not correct spelling, do not rename it to a "proper" dish name, do not translate it, do not normalize it.
- size: "half" if the customer said half / half-plate for that item, otherwise "full".
- quantity: number of that item ordered (default 1 if unstated).
- NEVER invent, guess, or estimate a price for any item — there is no price field for items; leave pricing out entirely.
- Extract customer contact details carefully:
  * customer_phone: Primary 10-digit Indian phone number.
  * call_number: Alternate or secondary call phone number if mentioned.
- LOCATION MANDATE:
  * Extract coordinates (lat, lng) whenever available (from Google Maps links, drops, or pin text).
  * If coordinates are present, set location_text to "lat, lng" (e.g. "26.4431, 91.4362").
  * Store any textual landmark/address separately in rider_notes.
- notes = kitchen instructions (spice level, no onion...).
- rider_notes = delivery instructions (landmark, building, floor, call before...).
- delivery_fee: only if explicitly mentioned, else 0.
- Return numbers as numbers, never strings. Unknown text fields = "".

Respond with JSON only.`;

  const schema = {
    type: "object",
    properties: {
      customer_name: { type: "string" },
      customer_phone: { type: "string" },
      call_number: { type: "string" },
      location_text: { type: "string" },
      location_lat: { type: "number" },
      location_lng: { type: "number" },
      notes: { type: "string" },
      rider_notes: { type: "string" },
      delivery_fee: { type: "number" },
      confidence: { type: "string" },
      summary: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            raw_name: { type: "string" },
            quantity: { type: "number" },
            size: { type: "string", enum: ["full", "half"] },
          },
          required: ["raw_name", "quantity", "size"],
        },
      },
    },
    required: ["customer_name", "customer_phone", "items"],
  };

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model || "gemini-2.5-flash")}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": c.geminiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 },
      }),
    }
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini ${r.status}`);
  const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}";
  return JSON.parse(raw);
}
async function createOrder(order) {
  const { items, ...head } = order;
  const inserted = await sb("draft_orders", {
    method: "POST",
    body: [head],
    prefer: "return=representation",
  });
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!row?.id) throw new Error("Draft order was not created.");

  if (items?.length) {
    await sb("draft_order_items", {
      method: "POST",
      body: items.map((i) => ({ ...i, draft_order_id: row.id })),
      prefer: "return=minimal",
    });
  }
  return row;
}

/**
 * Runs INSIDE the WhatsApp Web page's own JS context (world: "MAIN"), via
 * chrome.scripting.executeScript below — NOT via an injected <script> tag, which
 * WhatsApp's CSP now blocks outright (confirmed: "Executing inline script violates
 * CSP directive script-src ..." in the console). chrome.scripting with world:"MAIN"
 * is a browser-native mechanism for this exact purpose and is exempt from the
 * page's CSP.
 *
 * MUST be fully self-contained — Chrome serializes this via Function.toString() and
 * re-evaluates it in the page's world, so it cannot close over anything from
 * background.js's outer scope. All helpers are nested inside on purpose.
 *
 * Returns { phone, debug } — debug is relayed back to content.js's console so we can
 * see, from a REAL main-world execution this time, whether a webpack chunk registry
 * exists at all, whether a Chat store model was found, and how the fiber walk did.
 */
function mainWorldExtractJid() {
  const debug = {};

  // SAFETY: never accept a digit string just because it's numeric — validate it
  // actually looks like an Indian mobile number (10 digits starting 6-9, optionally
  // prefixed with country code 91) before treating it as a real phone. This is what
  // was missing last round — a 14-digit non-phone id (almost certainly a WhatsApp
  // "LID" — a newer privacy-preserving internal identifier, distinct from the phone
  // number) got returned as if it were valid.
  const PHONE_RE = /^(?:91)?([6-9]\d{9})$/;
  function validatePhone(raw) {
    if (!raw) return "";
    const digits = String(raw).replace(/\D/g, "");
    const m = digits.match(PHONE_RE);
    return m ? m[1] : "";
  }

  // Shallow, crash-proof object dumper (React fiber / WA model instances often have
  // circular refs and getters that throw) — used purely so we can SEE what was
  // matched, not to extract from.
  function safePreview(obj, depth) {
    depth = depth == null ? 2 : depth;
    const seen = new WeakSet();
    function walk(o, d) {
      if (o === null || typeof o !== "object") return o;
      if (d <= 0) return "[depth-limit]";
      if (seen.has(o)) return "[circular]";
      seen.add(o);
      if (Array.isArray(o)) return o.slice(0, 8).map((v) => { try { return walk(v, d - 1); } catch { return "[err]"; } });
      const out = {};
      let count = 0;
      for (const k of Object.keys(o)) {
        if (count++ > 20) { out["…"] = "[truncated]"; break; }
        try {
          const v = o[k];
          out[k] = typeof v === "function" ? "[fn]" : walk(v, d - 1);
        } catch (e) {
          out[k] = "[getter-error]";
        }
      }
      return out;
    }
    try { return walk(obj, depth); } catch (e) { return String(e); }
  }

  // jidToPhone now returns "" (not a wrong guess) if the id doesn't validate as a
  // real phone number, so callers correctly treat it as "not found" rather than a
  // usable-but-wrong answer.
  function jidToPhone(jid) {
    if (!jid) return "";
    const raw = typeof jid === "string" ? jid : (jid.user || jid._serialized || "");
    return validatePhone(raw);
  }

  // Shared extraction: given a "chat"-shaped object (from either the store or a
  // fiber walk), pull BOTH a validated phone and a human display name out of it in
  // one pass. The name check rejects candidates that are themselves just a phone
  // number string (so a chat with no real pushname doesn't come back with the
  // number duplicated into the name field).
  const NAME_LOOKS_LIKE_PHONE = /^\+?[\d\s-]{8,}$/;
  function extractContactFields(chatObj) {
    if (!chatObj) return { phone: "", name: "" };

    const idCandidates = [chatObj.id, chatObj.contact?.id, chatObj.__x_contact?.id];
    let phone = "";
    for (const idVal of idCandidates) {
      const v = jidToPhone(idVal);
      if (v) { phone = v; break; }
    }
    if (!phone) {
      phone = validatePhone(chatObj.contact?.phoneNumber) || validatePhone(chatObj.__x_contact?.phoneNumber);
    }

    // pushname/pushName is WhatsApp's term for the self-set display name a contact
    // shows even when you haven't saved them — exactly the "~Seema" shown in the
    // Contact Info panel. Checked first, ahead of any locally-saved name field,
    // since the DOM scan already handles the saved-name case just fine on its own.
    const nameCandidates = [
      chatObj.contact?.pushname,
      chatObj.contact?.pushName,
      chatObj.__x_contact?.pushname,
      chatObj.contact?.verifiedName,
      chatObj.formattedTitle,
      chatObj.contact?.name,
      chatObj.contact?.shortName,
    ];
    let name = "";
    for (const n of nameCandidates) {
      if (typeof n === "string" && n.trim() && !NAME_LOOKS_LIKE_PHONE.test(n.trim())) {
        name = n.trim();
        break;
      }
    }
    return { phone, name };
  }

  function findStoreViaWebpack() {
    try {
      const chunkNames = Object.keys(window).filter((k) => /^webpackChunk/i.test(k));
      debug.chunkNames = chunkNames;
      for (const name of chunkNames) {
        const chunk = window[name];
        if (!chunk || typeof chunk.push !== "function") continue;
        let required;
        chunk.push([["kr-probe-" + Date.now()], {}, (r) => { required = r; }]);
        if (!required) continue;
        const cache = required.c || {};
        debug.cacheSize = Object.keys(cache).length;
        for (const id of Object.keys(cache)) {
          const mod = cache[id]?.exports;
          if (!mod) continue;
          const chatModel =
            mod.Chat && (typeof mod.Chat.active === "function" || typeof mod.Chat.getActive === "function")
              ? mod.Chat
              : mod.default?.Chat && typeof mod.default.Chat.active === "function"
              ? mod.default.Chat
              : null;
          if (chatModel) return chatModel;
        }
      }
    } catch (e) {
      debug.webpackError = String(e);
    }
    return null;
  }

  // Walks the fiber tree collecting BOTH fields from every "chat"-shaped object
  // encountered, filling in whichever of phone/name is still missing as it goes,
  // and returning early only once both are found (or the walk runs out). Every
  // candidate seen (up to 4) gets a safe preview logged for visibility.
  function fiberWalkForChatFields() {
    const roots = [
      document.querySelector("#main"),
      document.querySelector("#app"),
      document.getElementById("pane-side"),
    ].filter(Boolean);
    debug.rootsFound = roots.length;
    debug.candidatesSeen = [];
    const result = { phone: "", name: "" };

    for (const el of roots) {
      const key = Object.keys(el).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$") || k.startsWith("__reactContainere$")
      );
      if (!key) continue;
      debug.fiberKeyFound = key;
      let curr = el[key];
      let hops = 0;
      while (curr && hops < 80) {
        const props = curr.memoizedProps || curr.pendingProps;
        const state = curr.memoizedState;
        const chat = props?.chat || props?.channel || props?.activeChat || state?.chat || state?.element?.chat;
        if (chat?.id || chat?.contact) {
          const r = extractContactFields(chat);
          if (r.phone && !result.phone) result.phone = r.phone;
          if (r.name && !result.name) result.name = r.name;
          if (debug.candidatesSeen.length < 4) {
            debug.candidatesSeen.push({
              preview: safePreview(chat.contact || chat.id, 1),
              server: chat.id?.server,
            });
          }
          if (result.phone && result.name) return result;
        }
        curr = curr.return;
        hops++;
      }
      debug.hopsWalked = hops;
    }
    return result;
  }

  let phone = "";
  let pushName = "";
  try {
    const chatModel = findStoreViaWebpack();
    debug.chatModelFound = !!chatModel;
    const active = chatModel?.active?.() || chatModel?.getActive?.() || chatModel?.models?.find?.((c) => c.active);
    debug.activeFound = !!active;
    if (active) {
      const r = extractContactFields(active);
      phone = r.phone;
      pushName = r.name;
    }
  } catch (e) {
    debug.storeError = String(e);
  }

  if (!phone || !pushName) {
    try {
      const r = fiberWalkForChatFields();
      if (!phone) phone = r.phone;
      if (!pushName) pushName = r.name;
    } catch (e) {
      debug.fiberError = String(e);
    }
  }

  debug.bundlerKeys = Object.keys(window).filter((k) =>
    /^webpackChunk|^__d$|^require$|requireLazy|__webpack|WAWebCmd/i.test(k)
  );

  return { phone, pushName, debug };
}

async function extractPageJid(tabId) {
  if (!tabId) throw new Error("No tab id available for scripting.executeScript");
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: mainWorldExtractJid,
  });
  return results?.[0]?.result || { phone: "", debug: {} };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "GET_CONFIG") return sendResponse({ ok: true, data: await cfg() });
      if (msg.type === "GET_MENU") return sendResponse({ ok: true, data: await getMenuCached() });
      if (msg.type === "REFRESH_MENU") return sendResponse({ ok: true, data: await refreshMenu() });
      if (msg.type === "GET_MENU_INFO") return sendResponse({ ok: true, data: (await readMenuCache()) || EMPTY_MENU_CACHE });
      if (msg.type === "PARSE_CHAT") return sendResponse({ ok: true, data: await parseChat(msg.payload) });
      if (msg.type === "CREATE_ORDER") return sendResponse({ ok: true, data: await createOrder(msg.payload) });
      if (msg.type === "EXTRACT_PAGE_JID") return sendResponse({ ok: true, data: await extractPageJid(_sender?.tab?.id) });
      sendResponse({ ok: false, error: "Unknown message" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});