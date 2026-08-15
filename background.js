// Service worker: Gemini parsing + Supabase writes.

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

async function getMenu() {
  const rows = await sb(
    "digital_menu?select=id,name,price,half_price,kitchen,category,is_available&is_available=eq.true&order=category.asc,display_order.asc"
  );
  return rows;
}

async function parseChat({ transcript, menu }) {
  const c = await cfg();
  if (!c.geminiKey) throw new Error("Gemini API key missing in extension settings.");

  const menuList = menu
    .map((m) => `${m.name} | ₹${m.price}${m.half_price ? ` (half ₹${m.half_price})` : ""}`)
    .join("\n");

  const prompt = `You extract food delivery orders from a WhatsApp conversation for an Indian restaurant.

MENU (name | price):
${menuList}

CONVERSATION (most recent messages, oldest first):
${transcript}

Rules:
- Only use the LATEST order intent in the conversation. Ignore older/completed orders.
- Match item names to the MENU list as closely as possible and use the MENU price as unit_price.
- If the customer says "half", use the half price and put "(Half)" in the item name.
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
            item_name: { type: "string" },
            quantity: { type: "number" },
            unit_price: { type: "number" },
          },
          required: ["item_name", "quantity", "unit_price"],
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
  const inserted = await sb("kitchen_orders", {
    method: "POST",
    body: [head],
    prefer: "return=representation",
  });
  const row = inserted[0];
  if (items?.length) {
    await sb("kitchen_order_items", {
      method: "POST",
      body: items.map((i) => ({ ...i, order_id: row.id })),
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

  // Instead of trusting the FIRST "chat"-shaped object's .id blindly, check several
  // plausible candidate fields (top-level id, nested contact id, an explicit
  // phoneNumber field some models keep even when addressed via lid) and only accept
  // one that actually validates. Every candidate seen (up to 4) gets previewed into
  // debug.candidatesSeen so we have full visibility even when nothing validates.
  function fiberWalkForChatJid() {
    const roots = [
      document.querySelector("#main"),
      document.querySelector("#app"),
      document.getElementById("pane-side"),
    ].filter(Boolean);
    debug.rootsFound = roots.length;
    debug.candidatesSeen = [];

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
        if (chat?.id) {
          const candidates = [
            ["chat.id", chat.id],
            ["chat.contact.id", chat.contact?.id],
            ["chat.contact.phoneNumber", chat.contact?.phoneNumber],
            ["chat.__x_contact.id", chat.__x_contact?.id],
          ];
          for (const [path, val] of candidates) {
            if (val == null) continue;
            const validated = jidToPhone(val);
            if (validated) return validated;
          }
          if (debug.candidatesSeen.length < 4) {
            debug.candidatesSeen.push({ path: "chat", preview: safePreview(chat.id, 1), server: chat.id?.server });
          }
        }
        curr = curr.return;
        hops++;
      }
      debug.hopsWalked = hops;
    }
    return "";
  }

  let phone = "";
  try {
    const chatModel = findStoreViaWebpack();
    debug.chatModelFound = !!chatModel;
    const active = chatModel?.active?.() || chatModel?.getActive?.() || chatModel?.models?.find?.((c) => c.active);
    debug.activeFound = !!active;
    if (active?.id) phone = jidToPhone(active.id);
  } catch (e) {
    debug.storeError = String(e);
  }

  if (!phone) {
    try {
      phone = fiberWalkForChatJid();
    } catch (e) {
      debug.fiberError = String(e);
    }
  }

  debug.bundlerKeys = Object.keys(window).filter((k) =>
    /^webpackChunk|^__d$|^require$|requireLazy|__webpack|WAWebCmd/i.test(k)
  );

  return { phone, debug };
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
      if (msg.type === "GET_MENU") return sendResponse({ ok: true, data: await getMenu() });
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