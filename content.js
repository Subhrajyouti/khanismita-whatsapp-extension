// WhatsApp Web content script: floating button -> extract chat -> pending kitchen draft.

(function () {
  if (document.getElementById("kr-fab")) return;

  const send = (type, payload) =>
    new Promise((res) => chrome.runtime.sendMessage({ type, payload }, res));

  /* ---------------- Phone Extraction via Page Context Injection ---------------- */

  /**
   * Previously this injected a <script> tag directly — confirmed BROKEN by WhatsApp's
   * current CSP: "Executing inline script violates CSP directive script-src ...".
   * The browser refuses to run it at all, silently, every time.
   *
   * Fix: ask background.js (which has the "scripting" permission) to run the
   * extraction via chrome.scripting.executeScript({ world: "MAIN" }) instead. That
   * API is a browser-native mechanism for running code in the page's own JS context
   * and is explicitly exempt from the page's CSP — it's not subject to script-src at
   * all, unlike a DOM-injected <script> tag.
   *
   * Returns { phone, pushName } — pulled from the SAME internal chat/contact object
   * in one round-trip. pushName is WhatsApp's term for a contact's self-set display
   * name (shown with a "~" prefix in the Contact Info panel) — it's visible for
   * saved AND unsaved contacts alike, unlike the phone number which is only shown as
   * text for unsaved ones.
   *
   * debug is logged here so we can see, from a REAL main-world execution, exactly
   * what was matched.
   */
  async function getContactInfoFromInternalStore() {
    try {
      const res = await send("EXTRACT_PAGE_JID");
      if (!res?.ok) {
        console.warn("[KR] EXTRACT_PAGE_JID failed:", res?.error);
        return { phone: "", pushName: "" };
      }
      const { phone, pushName, debug } = res.data || {};
      console.log("[KR] MAIN-world extraction debug (JSON):\n" + JSON.stringify(debug, null, 2));
      return { phone: phone || "", pushName: pushName || "" };
    } catch (e) {
      console.warn("[KR] EXTRACT_PAGE_JID threw:", e);
      return { phone: "", pushName: "" };
    }
  }

  /**
   * extractChat() calls this once. On a freshly-opened chat #main may still be
   * re-rendering when we inject, so retry once after a short delay for whichever
   * field (phone and/or pushName) is still missing, then merge the best of both
   * attempts rather than discarding a partial first result.
   */
  async function getContactInfoWithRetry() {
    let result = await getContactInfoFromInternalStore();
    if (!result.phone || !result.pushName) {
      await new Promise((r) => setTimeout(r, 350));
      const second = await getContactInfoFromInternalStore();
      result = { phone: result.phone || second.phone, pushName: result.pushName || second.pushName };
    }
    return result;
  }

  /* ---------------- Helper Utilities ---------------- */

  /**
   * BUG FIX: the old regex `/(?:\+91[\s-]?)?[6-9]\d{9}/` matched greedily against
   * concatenated digit runs like a WhatsApp JID "919876543210@c.us" — it would grab
   * "9198765432" (country code + first 8 digits of the real number) starting at
   * position 0, instead of the actual number "9876543210" one digit later, because
   * regex doesn't backtrack once an earlier match succeeds. Adding digit-boundary
   * lookaround (?<!\d) / (?!\d) means a match can't start or end in the middle of a
   * longer digit run, so it now correctly refuses to match inside a JID at all (use
   * extractPhoneFromJid for those) and only matches genuine standalone numbers typed
   * in message text, e.g. "call me on 9876543210" or "+91 98765 43210".
   */
  function extractPhoneFromText(text) {
    if (!text) return "";
    const cleaned = text.replace(/[\s-]/g, (m, offset, str) => {
      // collapse spaces/dashes ONLY when they sit between digits (so "98765 43210"
      // still matches as one number), but don't touch surrounding punctuation.
      const before = str[offset - 1], after = str[offset + 1];
      return /\d/.test(before) && /\d/.test(after) ? "" : m;
    });
    const matches = cleaned.match(/(?<!\d)(?:\+?91)?[6-9]\d{9}(?!\d)/g);
    if (matches && matches.length > 0) {
      return matches[matches.length - 1].replace(/\D/g, "").slice(-10);
    }
    return "";
  }

  /**
   * PRIMARY phone source: WhatsApp message elements carry a `data-id` attribute of
   * the form `{fromMe}_{jid}_{messageId}` (individual chats) or
   * `{fromMe}_{groupJid}_{messageId}_{participantJid}` (group chats). The jid is
   * always phone-number-based ("<digits>@c.us" or "@s.whatsapp.net") *regardless* of
   * whether the contact is saved in the phonebook — saved-name display is a UI-layer
   * concern only, it doesn't change the underlying id. This needs no store/fiber
   * access at all, so it's tried first.
   *
   * Caveat: WhatsApp has been migrating some identifiers to privacy-preserving
   * "@lid" (linked ID) values that are NOT phone numbers and can't be reversed
   * client-side. If every data-id on a chat ends in @lid instead of @c.us, the real
   * phone number isn't recoverable from the DOM or client state at all — flagged via
   * the returned `isLid` so the UI can tell the user to type it in manually instead
   * of silently showing a blank/wrong field.
   */
  const PHONE_RE = /^(?:91)?([6-9]\d{9})$/;
  function validatePhone(raw) {
    if (!raw) return "";
    const digits = String(raw).replace(/\D/g, "");
    const m = digits.match(PHONE_RE);
    return m ? m[1] : "";
  }

  function extractPhoneFromJid(raw) {
    if (!raw) return { phone: "", isLid: false };
    const str = String(raw);
    // Prefer the LAST @c.us/@s.whatsapp.net match: for incoming group messages the
    // real sender's jid is appended after the group's own jid.
    const waMatches = [...str.matchAll(/(\d{5,15})@(?:c\.us|s\.whatsapp\.net)/g)];
    if (waMatches.length) {
      const validated = validatePhone(waMatches[waMatches.length - 1][1]);
      if (validated) return { phone: validated, isLid: false };
    }
    if (/@lid/.test(str)) return { phone: "", isLid: true };
    return { phone: "", isLid: false };
  }

  function parseStamp(pre) {
    if (!pre) return null;
    const m = pre.match(/\[([^\]]+)\]\s*([^:]*):/);
    if (!m) return null;
    const [, stamp, author] = m;
    const parts = stamp.split(",").map((s) => s.trim());
    if (parts.length < 1) return { date: null, author };

    const timeRaw = parts[0];
    const ampm = /(am|pm)/i.exec(timeRaw)?.[1]?.toLowerCase();
    let [hh, mm] = timeRaw.replace(/\s*(am|pm)/i, "").split(":").map(Number);
    if (ampm === "pm" && hh < 12) hh += 12;
    if (ampm === "am" && hh === 12) hh = 0;

    const now = new Date();
    let date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh || 0, mm || 0);

    if (parts.length >= 2) {
      const d = parts[1].split("/").map(Number);
      if (d.length === 3) {
        let [a, b, y] = d;
        if (y < 100) y += 2000;
        let day = a, month = b;
        if (a > 12) { day = a; month = b; } else if (b > 12) { day = b; month = a; }
        date = new Date(y, month - 1, day, hh || 0, mm || 0);
      }
    }
    return { date: isNaN(date.getTime()) ? null : date, author };
  }

  /**
   * Inspects DOM elements (attributes, header info, image elements) for contact details.
   * Logs each stage with a "[KR]" prefix so you can open DevTools → Console on the
   * web.whatsapp.com tab, click the 🍛 button, and see exactly where it succeeds/fails.
   */
  function inspectDOMForContact() {
    const main = document.querySelector("#main");
    if (!main) {
      console.log("[KR] inspectDOMForContact: #main not found");
      return { name: "", phone: "", isLid: false };
    }

    const header = main.querySelector("header");
    let name = "";
    let phone = "";
    let isLid = false;

    if (header) {
      const titleEl = header.querySelector("span[title], span[dir='auto'], div[role='button'] span");
      name = titleEl?.getAttribute("title") || titleEl?.innerText?.trim() || "";

      const imgEl = header.querySelector("img");
      if (!name && imgEl && imgEl.alt) {
        name = imgEl.alt.replace(/avatar/i, "").trim();
      }
    }
    console.log("[KR] header name:", name || "(none)");

    // Primary: scan every message node's data-id for a real JID. This does not
    // depend on saved/unsaved contact status, page-context injection, or webpack —
    // it's a plain DOM attribute read.
    const msgNodes = main.querySelectorAll("[data-id]");
    console.log("[KR] message nodes with data-id found:", msgNodes.length);
    let sampleLogged = false;
    for (const node of msgNodes) {
      const dataId = node.getAttribute("data-id") || "";
      if (!sampleLogged && dataId) {
        console.log("[KR] sample data-id:", dataId);
        sampleLogged = true;
      }
      const result = extractPhoneFromJid(dataId);
      if (result.phone) {
        phone = result.phone;
        console.log("[KR] phone found via data-id:", phone);
        break;
      }
      if (result.isLid) isLid = true;
    }

    // Fallback: data-pre-plain-text / free-text scans (header subtext, message body)
    // — only useful for UNSAVED contacts where WhatsApp shows the raw number as the
    // display name/author, but cheap to try.
    if (!phone) {
      const subtextSpan = header?.querySelector("span[dir='ltr']");
      if (subtextSpan) phone = extractPhoneFromText(subtextSpan.innerText);
      if (!phone) phone = extractPhoneFromText(name);
    }
    if (!phone) {
      for (const node of main.querySelectorAll("[data-pre-plain-text]")) {
        const found = extractPhoneFromText(node.getAttribute("data-pre-plain-text") || "");
        if (found) { phone = found; break; }
      }
    }

    if (!phone && isLid) {
      console.warn(
        "[KR] Only @lid (privacy) identifiers found for this chat — WhatsApp is not exposing a " +
        "phone-based JID anywhere in the DOM for it, so this can't be recovered automatically. " +
        "Type the number in manually."
      );
    }
    if (!phone && !isLid) {
      console.warn("[KR] No phone found via DOM. Will try page-context injection next.");
    }

    return { name, phone, isLid };
  }

  async function extractChat(minutes) {
    const main = document.querySelector("#main");
    if (!main) return { transcript: "", count: 0, title: "", detectedPhone: "", isLid: false };

    // 1. DOM data-id JID scan first — synchronous, no page-context injection needed,
    //    and works regardless of saved/unsaved contact status. This is the primary,
    //    reliable path (see inspectDOMForContact for why).
    const domContact = inspectDOMForContact();
    let title = domContact.name || main.querySelector("header span[title]")?.getAttribute("title") || "";
    let detectedPhone = domContact.phone;
    let isLid = domContact.isLid;

    // For an UNSAVED contact, WhatsApp shows the phone number itself as the header
    // "name" — that's not a real name, it's just the identity WhatsApp had to show.
    // In that case (or when there's no title at all), go fetch WhatsApp's own
    // self-set display name ("pushname", the "~Seema" shown in Contact Info) from
    // the internal chat/contact object, same place the phone comes from.
    const titleIsJustAPhoneNumber = !title || /^\+?[\d\s-]{8,}$/.test(title.trim());
    console.log("[KR] raw title:", JSON.stringify(title), "| titleIsJustAPhoneNumber:", titleIsJustAPhoneNumber);

    // 2. Fall back to page-context injection (webpack/fiber internals) whenever the
    //    DOM scan didn't give us a real phone (and it's not an @lid privacy case,
    //    where the number genuinely isn't recoverable at all), OR when we still
    //    don't have a real display name for an unsaved contact.
    if ((!detectedPhone && !isLid) || titleIsJustAPhoneNumber) {
      console.log("[KR] Fetching from page-context (phone and/or pushname needed)…");
      const info = await getContactInfoWithRetry();
      if (!detectedPhone && info.phone) {
        detectedPhone = info.phone;
        console.log("[KR] phone found via page-context injection:", detectedPhone);
      }
      if (titleIsJustAPhoneNumber && info.pushName) {
        console.log("[KR] pushname found via page-context injection:", info.pushName);
        title = info.pushName;
      }
      if (!detectedPhone && !info.phone) console.warn("[KR] page-context injection found no phone for this chat.");
    }

    if (!detectedPhone) detectedPhone = extractPhoneFromText(title);

    const rows = [...main.querySelectorAll("div.message-in, div.message-out, div[role='row']")];

    // Raw diagnostic dump — run once regardless of whether phone was already found,
    // so we can see WhatsApp's CURRENT markup directly instead of guessing against
    // remembered structure. This is the fastest way to pinpoint what changed.
    console.log("[KR] === DOM DIAGNOSTIC ===");
    console.log("[KR] [data-id] anywhere in #main:", main.querySelectorAll("[data-id]").length);
    console.log("[KR] div.message-in:", main.querySelectorAll("div.message-in").length,
                "| div.message-out:", main.querySelectorAll("div.message-out").length,
                "| div[role='row']:", main.querySelectorAll("div[role='row']").length);
    console.log("[KR] tail-in:", main.querySelectorAll('[data-testid="tail-in"]').length,
                "| tail-out:", main.querySelectorAll('[data-testid="tail-out"]').length,
                "| [data-pre-plain-text]:", main.querySelectorAll("[data-pre-plain-text]").length);
    if (rows.length) {
      const sample = rows[rows.length - 1];
      console.log("[KR] last row outerHTML (truncated 1000 chars):", sample.outerHTML.slice(0, 1000));
      console.log("[KR] last row's own attributes:", [...sample.attributes].map(a => `${a.name}="${a.value}"`).join(" | "));
      let anc = sample.parentElement;
      for (let i = 0; i < 3 && anc; i++) {
        console.log(`[KR] ancestor ${i + 1} (${anc.tagName}) attributes:`, [...anc.attributes].map(a => `${a.name}="${a.value}"`).join(" | "));
        anc = anc.parentElement;
      }
    } else {
      console.log("[KR] No message rows matched any selector at all.");
    }

    // Header dump — does the phone number show up as visible text anywhere near the
    // contact name (tooltip title, aria-label, subtitle span)?
    const headerEl = main.querySelector("header");
    if (headerEl) {
      console.log("[KR] header outerHTML (truncated 1500 chars):", headerEl.outerHTML.slice(0, 1500));
    } else {
      console.log("[KR] No <header> found under #main.");
    }

    // Bundler fingerprint — figure out what module system this build actually uses,
    // since the StyleX atomic classes suggest this isn't the plain-webpack build the
    // earlier injection script assumed.
    const bundlerKeys = Object.keys(window).filter(k =>
      /^webpackChunk|^__d$|^require$|requireLazy|__webpack|WAWebCmd|__META/i.test(k)
    );
    console.log("[KR] window keys matching known bundler patterns:", bundlerKeys.length ? bundlerKeys : "(none found)");

    console.log("[KR] === END DIAGNOSTIC ===");

    const cutoff = Date.now() - minutes * 60 * 1000;
    const out = [];

    for (const row of rows) {
      const pre = row.querySelector("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text") || "";
      const info = pre ? parseStamp(pre) : null;
      if (info?.date && info.date.getTime() < cutoff) continue;

      const textEl =
        row.querySelector("span.selectable-text") ||
        row.querySelector("span._ao3e") ||
        row.querySelector("div.copyable-text") ||
        row.querySelector("span[dir='ltr']");

      const text = textEl?.innerText?.trim() || "";
      const link = [...row.querySelectorAll("a")].map((a) => a.href).find((h) => /maps|goo\.gl/.test(h));

      if (!detectedPhone) {
        detectedPhone = extractPhoneFromText(text);
      }

      // FIXED: "div.message-out" no longer exists on the current build (confirmed via
      // diagnostic: 0 matches). WhatsApp now marks outgoing messages with
      // data-testid="tail-out" (incoming = "tail-in") on the little bubble-tail
      // graphic. Keep the old class check too as a harmless fallback for older builds.
      const isOut =
        !!row.querySelector('[data-testid="tail-out"]') ||
        row.classList.contains("message-out") ||
        !!row.querySelector("div.message-out");
      const who = isOut ? "Restaurant" : (info?.author || "Customer");
      const body = [text, link].filter(Boolean).join(" ");
      if (body) out.push(`${who}: ${body}`);
    }

    const tail = out.slice(-60);
    console.log("[KR] final detectedPhone:", detectedPhone || "(none)", "| isLid:", isLid);
    return { transcript: tail.join("\n"), count: tail.length, title, detectedPhone, isLid };
  }

  function parseCoords(input) {
    if (!input) return null;
    const pats = [
      /[?&]q=(?:loc:)?(-?\d+\.\d+),\s*(-?\d+\.\d+)/i,
      /[?&]ll=(-?\d+\.\d+),\s*(-?\d+\.\d+)/i,
      /@(-?\d+\.\d+),(-?\d+\.\d+)/,
      /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
      /(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    ];
    for (const re of pats) {
      const m = input.match(re);
      if (m) {
        const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
      }
    }
    return null;
  }

  function showStatus(message, kind = "loading") {
    document.getElementById("kr-status")?.remove();
    const el = document.createElement("div");
    el.id = "kr-status";
    el.textContent = message;
    el.style.cssText = [
      "position:fixed",
      "right:24px",
      "bottom:88px",
      "z-index:2147483000",
      "max-width:320px",
      "padding:11px 14px",
      "border-radius:10px",
      "font:600 13px system-ui,sans-serif",
      "color:#fff",
      `background:${kind === "error" ? "#b91c1c" : kind === "success" ? "#15803d" : "#44403c"}`,
      "box-shadow:0 4px 14px rgba(0,0,0,.25)",
    ].join(";");
    document.body.appendChild(el);
    return el;
  }

  /* ---------------- Local item matching (menu never leaves the device) ----------------
   *
   * Gemini only ever sees the transcript and returns raw_name/quantity/size per item —
   * no prices, no menu. Matching those raw names back to real menu rows (and pricing
   * them) happens entirely here, against the cached menu snapshot from background.js.
   */

  const FILLER_WORDS = new Set([
    "plate", "plates", "pc", "pcs", "nos", "no", "full", "piece", "pieces",
    "qty", "order", "x", "the", "a", "an", "of",
  ]);

  function normalizeItemName(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w && !FILLER_WORDS.has(w))
      .join(" ")
      .trim();
  }

  function bigrams(str) {
    const s = str.replace(/\s+/g, "");
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  }

  // Dice coefficient over character bigrams — tolerant of typos/spacing differences
  // ("chiken curry" vs "chicken curry") in a way plain string equality isn't.
  function diceCoefficient(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    if (a === b) return 1;
    const ga = bigrams(a), gb = bigrams(b);
    if (!ga.length || !gb.length) return 0;
    const counts = new Map();
    for (const g of ga) counts.set(g, (counts.get(g) || 0) + 1);
    let matches = 0;
    for (const g of gb) {
      const c = counts.get(g) || 0;
      if (c > 0) { matches++; counts.set(g, c - 1); }
    }
    return (2 * matches) / (ga.length + gb.length);
  }

  // Word-level Jaccard overlap — catches cases like "veg fried rice" vs "fried rice veg"
  // where bigram similarity alone would be penalized by word order.
  function tokenOverlap(a, b) {
    const ta = new Set(a.split(" ").filter(Boolean));
    const tb = new Set(b.split(" ").filter(Boolean));
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    const union = ta.size + tb.size - inter;
    return union ? inter / union : 0;
  }

  // Price comes ONLY from the matched menu row — never from Gemini.
  function priceForMenuRow(row, isHalf) {
    if (!row) return 0;
    const p = isHalf
      ? row.effective_half_price ?? Math.round((Number(row.effective_price) || 0) / 2)
      : row.effective_price;
    return Number(p) || 0;
  }

  function saveAlias(normalized, menuItemId) {
    if (!normalized || menuItemId == null) return;
    chrome.storage.local.get({ aliases: {} }, (res) => {
      const aliases = res.aliases || {};
      aliases[normalized] = menuItemId;
      chrome.storage.local.set({ aliases });
    });
  }

  /**
   * Resolves Gemini's {raw_name, quantity, size} items against the cached menu.
   * 1. Exact alias hit (a name the user has manually matched before) short-circuits
   *    to a confident (score 1) match.
   * 2. Otherwise score every menu row via 0.6*Dice-bigram + 0.4*token-overlap.
   * ≥0.72 = confident, 0.45–0.72 = needs review, below = unmatched (unit_price 0).
   */
  function resolveItems(parsedItems, menu, aliases) {
    aliases = aliases || {};
    const menuNorm = (menu || []).map((m) => ({ row: m, norm: normalizeItemName(m.name) }));

    return (parsedItems || []).map((it) => {
      const rawName = it.raw_name || it.item_name || "";
      const norm = normalizeItemName(rawName);
      const isHalf = String(it.size || "").toLowerCase() === "half";
      const quantity = Number(it.quantity) || 1;

      const scored = menuNorm
        .map(({ row, norm: mnorm }) => ({
          row,
          score: 0.6 * diceCoefficient(norm, mnorm) + 0.4 * tokenOverlap(norm, mnorm),
        }))
        .sort((a, b) => b.score - a.score);

      const candidates = scored.slice(0, 3).map((c) => ({
        menu_item_id: c.row.id,
        item_name: c.row.name,
        score: Math.round(c.score * 100) / 100,
        unit_price: priceForMenuRow(c.row, isHalf),
      }));

      let bestRow = scored[0]?.row || null;
      let matchScore = scored[0]?.score || 0;

      const aliasId = aliases[norm];
      if (aliasId != null) {
        const aliasRow = (menu || []).find((m) => String(m.id) === String(aliasId));
        if (aliasRow) { bestRow = aliasRow; matchScore = 1; }
      }

      const status = matchScore >= 0.72 ? "confident" : matchScore >= 0.45 ? "review" : "unmatched";
      const matched = status !== "unmatched" ? bestRow : null;

      return {
        menu_item_id: matched ? matched.id : null,
        item_name: matched ? (isHalf ? `${matched.name} (Half)` : matched.name) : rawName,
        quantity,
        unit_price: matched ? priceForMenuRow(matched, isHalf) : 0,
        matchScore: Math.round(matchScore * 100) / 100,
        status,
        raw_name: rawName,
        is_half: isHalf,
        candidates,
        normalized: norm,
      };
    });
  }

  /* ---------------- UI ---------------- */

  const fab = document.createElement("button");
  fab.id = "kr-fab";
  fab.innerHTML = "🍛";
  fab.title = "Create Kitchen Order — drag to move";
  document.body.appendChild(fab);

  /* ---- Draggable FAB ----
   * Pointer Events cover mouse + touch in one API. A press only counts as a "drag"
   * once movement crosses DRAG_THRESHOLD px — below that it's treated as a normal
   * click so the panel still opens on a simple tap. Position is clamped to stay
   * fully on-screen (including on window resize) and persisted in
   * chrome.storage.local so it's remembered next time the page loads.
   */
  const FAB_POS_KEY = "krFabPos";
  const DRAG_THRESHOLD = 6;

  function clampFabPosition(left, top) {
    const margin = 4;
    const w = fab.offsetWidth || 52;
    const h = fab.offsetHeight || 52;
    const maxLeft = Math.max(margin, window.innerWidth - w - margin);
    const maxTop = Math.max(margin, window.innerHeight - h - margin);
    return { left: Math.min(Math.max(left, margin), maxLeft), top: Math.min(Math.max(top, margin), maxTop) };
  }

  function applyFabPosition(left, top) {
    fab.style.left = `${left}px`;
    fab.style.top = `${top}px`;
    fab.style.right = "auto";
    fab.style.bottom = "auto";
  }

  chrome.storage.local.get({ [FAB_POS_KEY]: null }, (res) => {
    const pos = res[FAB_POS_KEY];
    if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
      const c = clampFabPosition(pos.left, pos.top);
      applyFabPosition(c.left, c.top);
    }
  });

  let dragState = null;
  let didDrag = false;
  let suppressNextClick = false;

  fab.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return; // primary button/touch only
    const rect = fab.getBoundingClientRect();
    dragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
    didDrag = false;
    fab.setPointerCapture(e.pointerId);
  });

  fab.addEventListener("pointermove", (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!didDrag && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    didDrag = true;
    fab.classList.add("kr-dragging");
    const c = clampFabPosition(dragState.origLeft + dx, dragState.origTop + dy);
    applyFabPosition(c.left, c.top);
  });

  function endDrag(e) {
    if (!dragState) return;
    try { fab.releasePointerCapture(e.pointerId); } catch (_) {}
    fab.classList.remove("kr-dragging");
    if (didDrag) {
      // A "click" event still fires after pointerup even though the pointer moved
      // (setPointerCapture routes it to the fab regardless of where it's released) —
      // suppress just that one synthetic click so dropping the button doesn't also
      // pop the order panel open.
      suppressNextClick = true;
      const rect = fab.getBoundingClientRect();
      chrome.storage.local.set({ [FAB_POS_KEY]: { left: rect.left, top: rect.top } });
    }
    dragState = null;
  }
  fab.addEventListener("pointerup", endDrag);
  fab.addEventListener("pointercancel", endDrag);

  window.addEventListener("resize", () => {
    if (fab.style.left && fab.style.top) {
      const c = clampFabPosition(parseFloat(fab.style.left), parseFloat(fab.style.top));
      applyFabPosition(c.left, c.top);
    }
  });

  // { menu, menuVersion, fetchedAt } — refreshed (cheaply, via background's own
  // TTL/version-check) on every open, so a stale in-memory copy never lingers.
  let menuCache = null;

  fab.addEventListener("click", async (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const cfgRes = await send("GET_CONFIG");
    const minutes = cfgRes?.data?.lookback || 20;
    const chat = await extractChat(minutes);

    if (!chat.transcript) {
      alert("Open a chat first — no messages found in the last " + minutes + " minutes.");
      return;
    }

    const status = showStatus("Reading chat with Gemini…");

    try {
      const m = await send("GET_MENU");
      if (!m?.ok) throw new Error(m?.error || "Menu fetch failed");
      menuCache = m.data;

      // Gemini only ever sees the transcript — no menu, no prices.
      const p = await send("PARSE_CHAT", { transcript: chat.transcript });
      if (!p?.ok) throw new Error(p?.error || "AI parse failed");

      const parsed = p.data || {};
      const aliasesRes = await new Promise((res) => chrome.storage.local.get({ aliases: {} }, res));
      const resolvedItems = resolveItems(parsed.items || [], menuCache?.menu || [], aliasesRes.aliases || {});

      const draft = { ...parsed, items: resolvedItems };
      draft.customer_phone = draft.customer_phone || chat.detectedPhone || "";
      draft.customer_name = draft.customer_name || (/\d/.test(chat.title) ? "" : chat.title);

      let parsedLoc = parseCoords(draft.location_text);
      if (!parsedLoc && draft.location_lat && draft.location_lng) {
        parsedLoc = { lat: draft.location_lat, lng: draft.location_lng };
      }

      if (parsedLoc) {
        draft.location_text = `${parsedLoc.lat}, ${parsedLoc.lng}`;
      }

      const phone = String(draft.customer_phone || "").replace(/\D/g, "").slice(-10);
      if (phone.length !== 10) {
        throw new Error("Could not find a valid 10-digit customer phone number in this chat.");
      }
      if (!resolvedItems.length) {
        throw new Error("No order items were found in the latest customer messages.");
      }

      const address = parsedLoc
        ? (draft.rider_notes || null)
        : (draft.location_text || draft.rider_notes || null);
      const subtotal = resolvedItems.reduce(
        (sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unit_price) || 0),
        0
      );
      const deliveryFee = Number(draft.delivery_fee) || 0;

      status.textContent = "Sending order to Kitchen Orders…";
      const created = await send("CREATE_ORDER", {
        customer_name: draft.customer_name || (chat.title && !/^\+?[\d\s-]{8,}$/.test(chat.title) ? chat.title : "WhatsApp Customer"),
        customer_phone: phone,
        call_number: draft.call_number || null,
        address,
        location_lat: parsedLoc?.lat ?? null,
        location_lng: parsedLoc?.lng ?? null,
        notes: draft.notes || null,
        rider_notes: draft.rider_notes || null,
        delivery_fee: deliveryFee,
        total_amount: subtotal + deliveryFee,
        status: "pending",
        source: "whatsapp",
        items: resolvedItems.map((item) => ({
          menu_item_id: item.menu_item_id ?? null,
          item_name: item.item_name || item.raw_name || "",
          quantity: Number(item.quantity) || 1,
          unit_price: Number(item.unit_price) || 0,
          variant: item.is_half ? "half" : null,
        })),
      });
      if (!created?.ok) throw new Error(created?.error || "Could not send order to Kitchen Orders.");

      status.textContent = "Order sent to Kitchen Orders ✓";
      status.style.background = "#15803d";
      setTimeout(() => status.remove(), 2200);
    } catch (e) {
      status.textContent = String(e.message || e);
      status.style.background = "#b91c1c";
      setTimeout(() => status.remove(), 5000);
    }
  });

  function closePanel() {
    document.getElementById("kr-overlay")?.remove();
  }

  function openPanel({ draft, loading, error, meta }) {
    closePanel();
    const overlay = document.createElement("div");
    overlay.id = "kr-overlay";
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closePanel(); });

    const panel = document.createElement("div");
    panel.id = "kr-panel";
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    if (loading) {
      panel.innerHTML = `<h2 style="font-size:16px;">Reading chat with Gemini…</h2><div style="font-size:13px; color:#78716C; margin-top:6px;">Extracting items and customer details...</div>`;
      return;
    }
    if (error) {
      panel.innerHTML = `<h2 style="font-size:16px; color:#DC2626;">Something went wrong</h2><div style="font-size:13px; color:#78716C; margin-top:6px;">${error}</div>
        <button class="kr-add-btn" id="kr-close" style="margin-top:16px;">Close</button>`;
      panel.querySelector("#kr-close").onclick = closePanel;
      return;
    }

    const d = draft || {};
    const hasCallNum = Boolean(d.call_number);
    let orderType = d.order_type || "delivery";
    const items = (d.items || []).map((i) => ({
      item_name: i.item_name || i.raw_name || "",
      quantity: Number(i.quantity) || 1,
      unit_price: Number(i.unit_price) || 0,
      raw_name: i.raw_name || i.item_name || "",
      menu_item_id: i.menu_item_id ?? null,
      status: i.status || "manual", // "confident" | "review" | "unmatched" | "manual"
      matchScore: i.matchScore ?? null,
      candidates: i.candidates || [],
      normalized: i.normalized || normalizeItemName(i.raw_name || i.item_name || ""),
      is_half: !!i.is_half,
    }));

    panel.innerHTML = `
      <div class="kr-header">
        <h2>New Order</h2>
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="kr-type-pills">
            <button class="kr-pill ${orderType === 'delivery' ? 'active' : ''}" id="kr-pill-delivery">🛵 Delivery</button>
            <button class="kr-pill ${orderType === 'takeaway' ? 'active' : ''}" id="kr-pill-takeaway">🛍️ Takeaway</button>
          </div>
          <button class="kr-close-icon" id="kr-close-x">✕</button>
        </div>
      </div>

      <div class="kr-field">
        <label class="kr-label">Phone <span>*</span></label>
        <input class="kr-input" id="kr-phone" placeholder="${meta?.isLid && !d.customer_phone ? "Not auto-detectable for this chat — enter manually" : "10-digit number"}" value="${esc((d.customer_phone || "").replace(/\D/g, "").slice(-10))}">
        ${meta?.isLid && !d.customer_phone ? `<div style="font-size:12px; color:#B45309; margin-top:4px;">WhatsApp is using a privacy ID for this chat, so the number can't be pulled automatically — ask the customer or check your phone's WhatsApp app.</div>` : ""}
      </div>

      <div class="kr-checkbox-row">
        <input type="checkbox" id="kr-diff-call-cb" ${hasCallNum ? 'checked' : ''}>
        <label for="kr-diff-call-cb" style="cursor:pointer;">Different call number</label>
      </div>

      <div class="kr-field" id="kr-call-box" style="display:${hasCallNum ? 'block' : 'none'};">
        <label class="kr-label">Call number</label>
        <input class="kr-input" id="kr-call" placeholder="Call phone number" value="${esc(d.call_number || '')}">
      </div>

      <div class="kr-field">
        <label class="kr-label">Name</label>
        <input class="kr-input" id="kr-name" placeholder="Customer name" value="${esc(d.customer_name)}">
      </div>

      <div class="kr-field">
        <label class="kr-label">Location</label>
        <input class="kr-input" id="kr-loc" placeholder="lat,lng (paste from Maps)" value="${esc(d.location_text)}">
      </div>

      <div class="kr-field">
        <input class="kr-input" id="kr-address-text" placeholder="Address (text — shown to rider)" value="${esc(d.rider_notes || d.location_text || '')}">
      </div>

      <div class="kr-field">
        <label class="kr-label">Delivery fee (₹)</label>
        <input class="kr-input" type="number" id="kr-fee" value="${Number(d.delivery_fee) || 0}">
      </div>

      <div class="kr-field">
        <label class="kr-label">Items <span>*</span></label>
        <div id="kr-review-summary"></div>
        <div id="kr-items"></div>
        <button class="kr-add-btn" id="kr-additem">+ Add item</button>
      </div>

      <div class="kr-field">
        <textarea class="kr-textarea" id="kr-notes" placeholder="Kitchen note (optional)">${esc(d.notes)}</textarea>
      </div>

      <div class="kr-field">
        <textarea class="kr-textarea" id="kr-rnotes" placeholder="Rider note (optional, only rider sees this)">${esc(d.rider_notes)}</textarea>
      </div>

      <div class="kr-total-bar">Total: ₹<span id="kr-total">0.00</span></div>
      <div id="kr-msg"></div>

      <button class="kr-send-btn" id="kr-send">
        <span>✈</span> Send to Kitchen
      </button>
    `;

    const deliveryPill = panel.querySelector("#kr-pill-delivery");
    const takeawayPill = panel.querySelector("#kr-pill-takeaway");
    deliveryPill.onclick = () => {
      orderType = "delivery";
      deliveryPill.classList.add("active");
      takeawayPill.classList.remove("active");
    };
    takeawayPill.onclick = () => {
      orderType = "takeaway";
      takeawayPill.classList.add("active");
      deliveryPill.classList.remove("active");
    };

    const diffCb = panel.querySelector("#kr-diff-call-cb");
    const callBox = panel.querySelector("#kr-call-box");
    diffCb.onchange = () => { callBox.style.display = diffCb.checked ? "block" : "none"; };

    panel.querySelector("#kr-close-x").onclick = closePanel;

    const itemsBox = panel.querySelector("#kr-items");

    function renderItems() {
      itemsBox.innerHTML = "";

      const reviewCount = items.filter((i) => i.status === "review" || i.status === "unmatched").length;
      const summaryEl = panel.querySelector("#kr-review-summary");
      if (summaryEl) {
        summaryEl.innerHTML = reviewCount
          ? `<div class="kr-review-count">⚠ ${reviewCount} item${reviewCount === 1 ? "" : "s"} need${reviewCount === 1 ? "s" : ""} a menu match</div>`
          : "";
      }

      items.forEach((it, idx) => {
        const needsReview = it.status === "review" || it.status === "unmatched";
        const wrap = document.createElement("div");
        wrap.className = "kr-item-row-wrap" + (needsReview ? " kr-item-review" : "");

        const candidateOptions = (it.candidates || [])
          .map(
            (c) =>
              `<option value="${esc(String(c.menu_item_id))}">${esc(c.item_name)} — ₹${c.unit_price} · ${Math.round(c.score * 100)}% match</option>`
          )
          .join("");

        wrap.innerHTML = `
          ${needsReview ? `<div class="kr-review-flag">⚠ "${esc(it.raw_name || it.item_name)}" isn't a confident menu match — pick one, or search below:</div>` : ""}
          <div class="kr-item-row">
            <input class="kr-input" value="${esc(it.item_name)}" data-f="item_name" placeholder="Search menu item..." list="kr-menu">
            <input class="kr-input" type="number" min="1" value="${it.quantity}" data-f="quantity">
            <input class="kr-input" type="number" min="0" value="${it.unit_price}" data-f="unit_price">
            <button class="kr-del-btn" title="Remove">✕</button>
          </div>
          ${needsReview ? `
            <select class="kr-input kr-candidate-select">
              <option value="">— pick closest match —</option>
              ${candidateOptions}
            </select>` : ""}`;

        wrap.querySelectorAll("input[data-f]").forEach((inp) => {
          inp.addEventListener("input", () => {
            const f = inp.dataset.f;
            items[idx][f] = f === "item_name" ? inp.value : Number(inp.value) || 0;
            if (f === "item_name") {
              // Typing/selecting an exact menu name (via the "kr-menu" datalist, which
              // covers the full cached menu) resolves the item just like picking from
              // the candidate <select> does.
              const hit = (menuCache?.menu || []).find((m) => m.name.toLowerCase() === inp.value.trim().toLowerCase());
              if (hit) {
                const price = priceForMenuRow(hit, items[idx].is_half);
                items[idx].unit_price = price;
                items[idx].menu_item_id = hit.id;
                items[idx].status = "confident";
                items[idx].matchScore = 1;
                saveAlias(items[idx].normalized, hit.id);
                renderItems();
                calcTotal();
                const refocused = itemsBox.querySelectorAll(".kr-item-row")[idx]?.querySelector('[data-f="item_name"]');
                if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
                return;
              }
            }
            calcTotal();
          });
        });

        const select = wrap.querySelector(".kr-candidate-select");
        if (select) {
          select.addEventListener("change", () => {
            if (!select.value) return;
            const hit = (menuCache?.menu || []).find((m) => String(m.id) === select.value);
            if (!hit) return;
            const price = priceForMenuRow(hit, items[idx].is_half);
            items[idx].item_name = items[idx].is_half ? `${hit.name} (Half)` : hit.name;
            items[idx].unit_price = price;
            items[idx].menu_item_id = hit.id;
            items[idx].status = "confident";
            items[idx].matchScore = 1;
            saveAlias(items[idx].normalized, hit.id);
            renderItems();
            calcTotal();
          });
        }

        wrap.querySelector(".kr-del-btn").onclick = () => { items.splice(idx, 1); renderItems(); calcTotal(); };
        itemsBox.appendChild(wrap);
      });

      if (!panel.querySelector("#kr-menu")) {
        const dl = document.createElement("datalist");
        dl.id = "kr-menu";
        (menuCache?.menu || []).forEach((m) => {
          const o = document.createElement("option");
          o.value = m.name;
          dl.appendChild(o);
        });
        panel.appendChild(dl);
      }
    }

    function calcTotal() {
      const sub = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
      const fee = Number(panel.querySelector("#kr-fee").value) || 0;
      const t = Math.max(0, sub + fee);
      panel.querySelector("#kr-total").textContent = t.toFixed(2);
      return t;
    }

    renderItems();
    calcTotal();

    panel.querySelector("#kr-additem").onclick = () => {
      items.push({
        item_name: "", quantity: 1, unit_price: 0, raw_name: "", menu_item_id: null,
        status: "manual", matchScore: null, candidates: [], normalized: "", is_half: false,
      });
      renderItems();
    };

    panel.querySelector("#kr-fee").addEventListener("input", calcTotal);

    panel.querySelector("#kr-send").onclick = async (ev) => {
      const btn = ev.currentTarget;
      const msg = panel.querySelector("#kr-msg");
      const phone = panel.querySelector("#kr-phone").value.replace(/\D/g, "").slice(-10);

      if (phone.length !== 10) { msg.className = "kr-err"; msg.textContent = "Please enter a valid 10-digit phone number."; return; }
      if (!items.length) { msg.className = "kr-err"; msg.textContent = "Add at least one menu item."; return; }

      btn.disabled = true; btn.innerHTML = "Sending to Kitchen…";
      msg.className = ""; msg.textContent = "";

      const locInput = panel.querySelector("#kr-loc").value.trim();
      const coords = parseCoords(locInput);

      const payload = {
        customer_phone: phone,
        customer_name: panel.querySelector("#kr-name").value.trim() || "WhatsApp Customer",
        call_number: diffCb.checked ? (panel.querySelector("#kr-call").value.trim() || null) : null,
        location_text: locInput || null,
        location_lat: coords?.lat || null,
        location_lng: coords?.lng || null,
        notes: panel.querySelector("#kr-notes").value.trim() || null,
        rider_notes: panel.querySelector("#kr-address-text").value.trim() || panel.querySelector("#kr-rnotes").value.trim() || null,
        order_type: orderType,
        delivery_fee_charged: Number(panel.querySelector("#kr-fee").value) || 0,
        total_amount: calcTotal(),
        status: "pending",
        // Match metadata (menu_item_id/status/candidates/…) is UI-only — the
        // Supabase insert flow is unchanged and only expects these three fields.
        items: items.map(({ item_name, quantity, unit_price }) => ({ item_name, quantity, unit_price })),
      };

      const res = await send("CREATE_ORDER", payload);
      if (res?.ok) {
        msg.className = "kr-ok";
        msg.textContent = `Order sent to kitchen ✓`;
        btn.innerHTML = "Sent ✓";
        setTimeout(closePanel, 1200);
      } else {
        msg.className = "kr-err";
        msg.textContent = res?.error || "Failed to create order.";
        btn.disabled = false; btn.innerHTML = "✈ Send to Kitchen";
      }
    };
  }

  function esc(v) {
    return String(v ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }
})();