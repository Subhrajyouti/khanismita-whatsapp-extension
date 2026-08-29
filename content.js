// WhatsApp Web content script: floating button -> extract chat -> pending kitchen draft.

(function () {
  if (document.getElementById("kr-fab")) return;

  const send = (type, payload) =>
    new Promise((res) => chrome.runtime.sendMessage({ type, payload }, res));

  /* ---------------- Phone Extraction via Page Context Injection ---------------- */

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

  function extractPhoneFromText(text) {
    if (!text) return "";
    const cleaned = text.replace(/[\s-]/g, (m, offset, str) => {
      const before = str[offset - 1], after = str[offset + 1];
      return /\d/.test(before) && /\d/.test(after) ? "" : m;
    });
    const matches = cleaned.match(/(?<!\d)(?:\+?91)?[6-9]\d{9}(?!\d)/g);
    if (matches && matches.length > 0) {
      return matches[matches.length - 1].replace(/\D/g, "").slice(-10);
    }
    return "";
  }

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

  function inspectDOMForContact() {
    const main = document.querySelector("#main");
    if (!main) return { name: "", phone: "", isLid: false };

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

    const msgNodes = main.querySelectorAll("[data-id]");
    for (const node of msgNodes) {
      const dataId = node.getAttribute("data-id") || "";
      const result = extractPhoneFromJid(dataId);
      if (result.phone) {
        phone = result.phone;
        break;
      }
      if (result.isLid) isLid = true;
    }

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

    return { name, phone, isLid };
  }

  async function extractChat(minutes) {
    const main = document.querySelector("#main");
    if (!main) return { transcript: "", count: 0, title: "", detectedPhone: "", isLid: false };

    const domContact = inspectDOMForContact();
    let title = domContact.name || main.querySelector("header span[title]")?.getAttribute("title") || "";
    let detectedPhone = domContact.phone;
    let isLid = domContact.isLid;

    const titleIsJustAPhoneNumber = !title || /^\+?[\d\s-]{8,}$/.test(title.trim());

    if ((!detectedPhone && !isLid) || titleIsJustAPhoneNumber) {
      const info = await getContactInfoWithRetry();
      if (!detectedPhone && info.phone) detectedPhone = info.phone;
      if (titleIsJustAPhoneNumber && info.pushName) title = info.pushName;
    }

    if (!detectedPhone) detectedPhone = extractPhoneFromText(title);

    const rows = [...main.querySelectorAll("div.message-in, div.message-out, div[role='row']")];
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

      if (!detectedPhone) detectedPhone = extractPhoneFromText(text);

      const isOut =
        !!row.querySelector('[data-testid="tail-out"]') ||
        row.classList.contains("message-out") ||
        !!row.querySelector("div.message-out");
      const who = isOut ? "Restaurant" : (info?.author || "Customer");
      const body = [text, link].filter(Boolean).join(" ");
      if (body) out.push(`${who}: ${body}`);
    }

    const tail = out.slice(-60);
    return { transcript: tail.join("\n"), count: tail.length, title, detectedPhone, isLid };
  }

  function parseCoords(input) {
    if (!input) return null;
    try {
      const decodedUrl = decodeURIComponent(input);
      const pats = [
        /[?&]q=(?:loc:)?(-?\d+\.\d+),\s*(-?\d+\.\d+)/i,
        /[?&]ll=(-?\d+\.\d+),\s*(-?\d+\.\d+)/i,
        /@(-?\d+\.\d+),(-?\d+\.\d+)/,
        /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
        /(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/
      ];
      for (const re of pats) {
        const m = decodedUrl.match(re);
        if (m) {
          const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
          if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
            return { lat: m[1], lng: m[2], full: `${m[1]}, ${m[2]}` };
          }
        }
      }
    } catch (e) {
      console.error("Coordinate extraction error:", e);
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

  /* ---------------- Local item matching ---------------- */

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

  function tokenOverlap(a, b) {
    const ta = new Set(a.split(" ").filter(Boolean));
    const tb = new Set(b.split(" ").filter(Boolean));
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    const union = ta.size + tb.size - inter;
    return union ? inter / union : 0;
  }

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

  /* ---------------- Main FAB UI ---------------- */

  const fab = document.createElement("button");
  fab.id = "kr-fab";
  fab.innerHTML = "🍛";
  fab.title = "Create Kitchen Order — drag to move";
  document.body.appendChild(fab);

  /* ---------------- Location Sub-FAB & Popup ---------------- */

  const locFab = document.createElement("button");
  locFab.id = "kr-loc-fab";
  locFab.innerHTML = "📍";
  locFab.title = "Copy Chat Location";
  locFab.style.display = "none";
  document.body.appendChild(locFab);

  let activeChatCoords = null;

  function updateLocFabPosition() {
    const fabRect = fab.getBoundingClientRect();
    locFab.style.left = `${fabRect.left - 46}px`;
    locFab.style.top = `${fabRect.top + 6}px`;
  }

  function showCoordinatePopup(coords) {
    const existingPopup = document.getElementById("wa-coord-popup");
    if (existingPopup) existingPopup.remove();

    const popup = document.createElement("div");
    popup.id = "wa-coord-popup";
    popup.className = "wa-coord-container";

    popup.innerHTML = `
      <div class="wa-coord-header">
        <span>📍 Location</span>
        <button id="wa-coord-close">&times;</button>
      </div>
      <div class="wa-coord-body">
        <div class="wa-coord-value">${coords.full}</div>
        <button id="wa-coord-copy">Copy</button>
      </div>
    `;

    document.body.appendChild(popup);

    // Position directly beside/above the location button
    const locRect = locFab.getBoundingClientRect();
    const popupWidth = 140; 
    let leftPos = locRect.left - popupWidth - 8; // place to the left of the location button
    
    // Fallback if off-screen
    if (leftPos < 10) {
      leftPos = locRect.right + 8; 
    }

    popup.style.left = `${leftPos}px`;
    popup.style.top = `${locRect.top - 20}px`;

    const copyBtn = document.getElementById("wa-coord-copy");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(coords.full).then(() => {
        copyBtn.innerText = "Copied!";
        copyBtn.style.backgroundColor = "#25D366";
        setTimeout(() => {
          popup.remove();
        }, 1000); // Vanishes in 1 second
      });
    });

    document.getElementById("wa-coord-close").addEventListener("click", () => {
      popup.remove();
    });
  }

  locFab.addEventListener("click", () => {
    if (!activeChatCoords) return;
    showCoordinatePopup(activeChatCoords);
  });

  locFab.addEventListener("click", () => {
    if (!activeChatCoords) return;
    navigator.clipboard.writeText(activeChatCoords.full).then(() => {
      showCoordinatePopup(activeChatCoords);
    });
  });

  // Scans active chat for Map links or direct coordinates
  function scanChatForLocation() {
    const main = document.querySelector("#main");
    if (!main) {
      locFab.style.display = "none";
      activeChatCoords = null;
      return;
    }

    let foundCoords = null;

    // Scan map links
    const mapLinks = main.querySelectorAll('a[href*="maps.google.com"], a[href*="google.com/maps"], a[href*="maps.apple.com"], a[href*="goo.gl"]');
    for (const a of mapLinks) {
      foundCoords = parseCoords(a.href);
      if (foundCoords) break;
    }

    // Scan plain text if not found in links
    if (!foundCoords) {
      const messages = main.querySelectorAll("span.selectable-text, span._ao3e");
      for (const msg of messages) {
        foundCoords = parseCoords(msg.innerText);
        if (foundCoords) break;
      }
    }

    if (foundCoords) {
      activeChatCoords = foundCoords;
      updateLocFabPosition();
      locFab.style.display = "flex";
    } else {
      activeChatCoords = null;
      locFab.style.display = "none";
    }
  }

  // Observer to auto-detect location when switching chats or sending/receiving messages
  const chatObserver = new MutationObserver(() => scanChatForLocation());
  chatObserver.observe(document.body, { childList: true, subtree: true });

  /* ---------------- Draggable FAB logic ---------------- */

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
    updateLocFabPosition();
  }

  chrome.storage.local.get({ [FAB_POS_KEY]: null }, (res) => {
    const pos = res[FAB_POS_KEY];
    if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
      const c = clampFabPosition(pos.left, pos.top);
      applyFabPosition(c.left, c.top);
    } else {
      updateLocFabPosition();
    }
  });

  let dragState = null;
  let didDrag = false;
  let suppressNextClick = false;

  fab.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
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
        parsedLoc = { lat: draft.location_lat, lng: draft.location_lng, full: `${draft.location_lat}, ${draft.location_lng}` };
      }

      if (parsedLoc) {
        draft.location_text = parsedLoc.full;
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
})();