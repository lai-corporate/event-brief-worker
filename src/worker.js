import { extractText } from "unpdf";

export default {
  async fetch(request) {
    console.log("✅ fetch entered", request.method, request.url);

    const url = new URL(request.url);
    const qp = url.searchParams;

    const requestId =
      (globalThis.crypto?.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + "-" + Math.random().toString(16).slice(2));

    const debug = qp.get("debug") === "1" || qp.get("debug") === "true";

    // Performance knobs
    const maxPages = clampInt(qp.get("maxPages"), 1, 10, 1); // default 1 page
    const includeRaw = qp.get("raw") === "1";                // default false
    const includePages = qp.get("pages") === "1";            // default false

    const t0 = Date.now();
    const log = (...args) => { if (debug) console.log(`[${requestId}]`, ...args); };
    const errlog = (...args) => console.error(`[${requestId}]`, ...args);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OK");
    }

    if (request.method === "POST" && url.pathname === "/api/extract-all") {
      try {
        const ct = (request.headers.get("content-type") || "").toLowerCase();
        log("incoming", { method: request.method, path: url.pathname, ct, maxPages, includeRaw, includePages });

        const tRead0 = Date.now();
        const pdfBytes = await readPdfBytes(request, ct, log);
        const readMs = Date.now() - tRead0;

        if (!pdfBytes || pdfBytes.length < 10) {
          return json({ ok: false, error: "empty_body", meta: { requestId } }, 400);
        }

        log("pdf bytes", { length: pdfBytes.length, readMs });

        // ---- Extract text via unpdf (pure JS) ----
        const tExtract0 = Date.now();
        const result = await extractText(pdfBytes);
        const fullText = normalize(String(result?.text || ""));
        const { rawText, pages, extractedPages } = buildPagedText(fullText, maxPages);
        const extractMs = Date.now() - tExtract0;

        // Parse
        const tParse0 = Date.now();
        const parsed = parseLaiEventBrief(rawText);
        const parseMs = Date.now() - tParse0;

        const totalMs = Date.now() - t0;

        const res = {
          ok: true,
          parsed,
          meta: {
            requestId,
            contentType: ct || null,
            extractedPages,
            timingsMs: { readMs, extractMs, parseMs, totalMs }
          }
        };

        if (includePages) res.pages = pages;
        if (includeRaw) res.rawText = rawText;

        if (debug) {
          res.debug = {
            url: request.url,
            notes:
              "unpdf is pure JS; paging is best-effort if the PDF text has no page separators. Parser is label/section driven to tolerate template changes."
          };
        }

        log("success", { bookingNumber: parsed?.bookingNumber, totalMs });
        return json(res);

      } catch (e) {
        errlog("extract_failed", {
          message: e?.message,
          stack: e?.stack,
          url: request.url
        });

        return json(
          {
            ok: false,
            error: "extract_failed",
            message: String(e?.message || e),
            meta: { requestId }
          },
          500
        );
      }
    }

    return new Response("Not found", { status: 404 });
  }
};

// ---------- helpers ----------

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function readPdfBytes(request, contentType, log) {
  if (contentType.includes("application/json")) {
    const j = await request.json();
    const b64 = j?.$content || j?.content || null;
    if (!b64) return null;
    log("json wrapper detected", { hasContent: !!b64, contentType });
    return base64ToUint8Array(b64);
  }
  const buf = await request.arrayBuffer();
  return new Uint8Array(buf);
}

function base64ToUint8Array(b64) {
  const clean = String(b64 || "").replace(/^data:.*?;base64,/, "");
  const bin = atob(clean);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/**
 * Best-effort paging.
 * 1) If text contains \f form-feed, use that.
 * 2) Else if it contains "Page X of Y", split on those markers.
 * 3) Else treat as single page.
 */
function buildPagedText(fullText, maxPages) {
  const text = String(fullText || "").trim();

  // 1) Form-feed based
  const ffChunks = text.split("\f").map(s => s.trim()).filter(Boolean);
  if (ffChunks.length >= 2) {
    const take = Math.min(ffChunks.length, maxPages);
    const pages = ffChunks.slice(0, take).map((t, i) => ({ page: i + 1, text: t, ms: 0 }));
    const rawText = pages.map(x => `\n\n=== PAGE ${x.page} ===\n${x.text}`).join("");
    return { rawText, pages, extractedPages: pages.length };
  }

  // 2) "Page X of Y" markers
  const markerRe = /(?=\bPage\s+\d+\s+of\s+\d+\b)/gi;
  const markerChunks = text.split(markerRe).map(s => s.trim()).filter(Boolean);

  if (markerChunks.length >= 2) {
    const take = Math.min(markerChunks.length, maxPages);
    const pages = markerChunks.slice(0, take).map((t, i) => ({ page: i + 1, text: t, ms: 0 }));
    const rawText = pages.map(x => `\n\n=== PAGE ${x.page} ===\n${x.text}`).join("");
    return { rawText, pages, extractedPages: pages.length };
  }

  // 3) single page fallback
  const pages = [{ page: 1, text, ms: 0 }];
  const rawText = `\n\n=== PAGE 1 ===\n${text}`;
  return { rawText, pages, extractedPages: 1 };
}

/**
 * Parse fields we can reliably pull from LAI Event Brief PDFs
 * Output is stable even if fields are missing/renamed.
 */
function parseLaiEventBrief(rawText) {
  const t = normalize(rawText);

  // ---- 1) Basic header facts (booking # is usually reliable) ----
  const bookingNumber = match1(t, /Booking\s*#\s*(\d{5,12})/i);

  // ---- 2) Segment into sections by headings (supports variants + repeated headings) ----
  const sectionMap = splitByHeadingsMulti(t, [
    "CONTACT INFORMATION",
    "SCHEDULE OF EVENTS",
    "EVENT DETAILS",
    "CLIENT DETAILS",
    "EVENT AGENDA",
    "TALENT INTRODUCTION",
    "EMERGENCY TRAVEL NUMBERS",
    "STAGE DIAGRAM",
    "COX CAMPUS MAP"
  ]);

  const contactBlock = (sectionMap["CONTACT INFORMATION"]?.[0] || "");

  // ---- 3) Parse header block (don’t rely on fixed indices) ----
  const headerBlock = matchBlock(t, /-\s*-\s*-\s*\n([\s\S]*?)\nCONTACT INFORMATION/i);
  const header = parseHeaderBlock(headerBlock);

  // ---- 4) Parse sites ----
  const sites = parseSitesFromContactInfo(contactBlock);

  // ---- 5) Parse contacts ----
  const contacts = parseContactsFromContactInfo(contactBlock);

  // ---- 6) Schedule parsing ----
  const scheduleBlock = (sectionMap["SCHEDULE OF EVENTS"]?.[0] || null);
  const flights = scheduleBlock ? parseFlights(scheduleBlock) : [];

  // Optional: retain raw long sections
  const eventDetails = (sectionMap["EVENT DETAILS"]?.[0] || null);
  const clientDetails = (sectionMap["CLIENT DETAILS"]?.[0] || null);
  const talentIntro = (sectionMap["TALENT INTRODUCTION"]?.[0] || null);

  // ---- 7) Confidence ----
  const confidence = computeConfidence({
    bookingNumber,
    talentName: header.talentName,
    clientName: header.clientName,
    eventTitle: header.eventTitle,
    eventDateText: header.eventDateText,
    sites,
    contacts
  });

  return {
    bookingNumber,
    header,
    sites,
    contacts,
    schedule: scheduleBlock ? { flights, raw: scheduleBlock } : null,
    sections: {
      contactInformation: contactBlock || null,
      eventDetails,
      clientDetails,
      talentIntroduction: talentIntro
    },
    confidence
  };
}

/* ------------------------- SECTION SPLITTING ------------------------- */

/**
 * Multi-section splitter: returns arrays per heading so repeated headings don't break parsing.
 * Example: map["EVENT DETAILS"] = ["...", "..."] if it appears twice.
 */
function splitByHeadingsMulti(text, headings) {
  const hits = [];

  for (const h of headings) {
    const re = new RegExp(`\\b${escapeRe(h).replace(/\\s+/g, "\\\\s+")}\\b`, "ig");
    let m;
    while ((m = re.exec(text))) {
      hits.push({ heading: h, idx: m.index, len: m[0].length });
    }
  }

  hits.sort((a, b) => a.idx - b.idx);

  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].idx + hits[i].len;
    const end = i + 1 < hits.length ? hits[i + 1].idx : text.length;

    const h = hits[i].heading;
    const chunk = text.slice(start, end).trim();

    if (!out[h]) out[h] = [];
    out[h].push(chunk);
  }

  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------- HEADER PARSING ------------------------- */

function parseHeaderBlock(block) {
  if (!block) {
    return { talentName: null, clientName: null, eventTitle: null, eventDateText: null, raw: null };
  }
  const lines = block.split("\n").map(x => x.trim()).filter(Boolean);

  const dateIdx = lines.findIndex(l =>
    /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(l) ||
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(l)
  );
  const eventDateText = dateIdx >= 0 ? lines[dateIdx] : null;

  const talentName = lines[0] || null;

  let clientName = null, eventTitle = null;
  if (dateIdx >= 0) {
    clientName = lines[1] || null;
    eventTitle = lines[2] || null;
  } else {
    clientName = lines[1] || null;
    eventTitle = lines[2] || null;
  }

  return { talentName, clientName, eventTitle, eventDateText, raw: block };
}

/* ------------------------- SITES PARSING ------------------------- */

function parseSitesFromContactInfo(contactBlock) {
  if (!contactBlock) return [];

  const siteLabels = [
    { type: "event", label: "EVENT SITE" },
    { type: "event", label: "EVENT\\/HOTEL SITE" }, // sometimes combined
    { type: "hotel", label: "HOTEL SITE" },
    { type: "hotel", label: "HOTEL" } // occasional shorthand
  ];

  const labelPositions = [];
  for (const s of siteLabels) {
    const re = new RegExp(`\\b${s.label}\\b\\s*:\\s*`, "i");
    const m = re.exec(contactBlock);
    if (m) labelPositions.push({ ...s, idx: m.index, matchLen: m[0].length });
  }
  labelPositions.sort((a, b) => a.idx - b.idx);

  const nextCapsLabelRe = /\n[A-Z][A-Z \/\*]{3,}:\s*/g;

  const sites = [];
  for (let i = 0; i < labelPositions.length; i++) {
    const start = labelPositions[i].idx + labelPositions[i].matchLen;
    const end = i + 1 < labelPositions.length ? labelPositions[i + 1].idx : contactBlock.length;
    let chunk = contactBlock.slice(start, end).trim();

    // cut at next caps label if present inside chunk
    const m2 = nextCapsLabelRe.exec("\n" + chunk);
    if (m2 && m2.index > 0) chunk = chunk.slice(0, m2.index).trim();

    const parsed = parseAddressBlock(chunk);
    const hotelDetails = (labelPositions[i].type === "hotel") ? parseHotelDetails(chunk) : null;

    sites.push({
      type: labelPositions[i].type,
      label:
        labelPositions[i].type === "event" ? "EVENT SITE" : "HOTEL SITE",
      ...parsed,
      ...(hotelDetails ? { hotelDetails } : {}),
      raw: chunk
    });
  }

  // If none found but contact block contains a clear venue address/phone, keep fallback as event site
  if (!sites.length) {
    const fallbackPhone = match1(contactBlock, /Phone:\s*([0-9()\- ]{7,})/i);
    if (fallbackPhone) {
      sites.push({
        type: "event",
        label: "EVENT SITE",
        ...parseAddressBlock(contactBlock),
        raw: contactBlock
      });
    }
  }

  return sites;
}

function parseAddressBlock(block) {
  const lines = String(block || "").split("\n").map(s => s.trim()).filter(Boolean);

  const name = lines[0] || null;
  const phone = match1(block, /Phone:\s*([0-9()\- ]{7,})/i);
  const email = match1(block, /Email:\s*([^\s]+@[^\s]+)/i);

  const addrLines = lines
    .filter(l => !/^Phone:/i.test(l) && !/^Email:/i.test(l))
    .slice(0, 4); // allow 4 lines because some include suite/floor
  const address = addrLines.length ? addrLines.join(", ") : null;

  return { name, address, phone, email };
}

function parseHotelDetails(block) {
  const checkIn = match1(block, /Check-?In:\s*([^\n]+)/i);
  const checkOut = match1(block, /Check-?Out:\s*([^\n]+)/i);
  const confirmation = match1(block, /Confirmation(?:\s*#|\s*Number)?:\s*([A-Z0-9\-]+)/i);
  const roomType = match1(block, /Room Type:\s*([^\n]+)/i);
  const nights = match1(block, /Nights:\s*(\d+)/i);
  const rate = match1(block, /Rate:\s*([$€£]?\s*[0-9,]+(?:\.[0-9]{2})?)/i);

  // only return if at least one is present
  if (!(checkIn || checkOut || confirmation || roomType || nights || rate)) return null;

  return {
    checkIn: checkIn || null,
    checkOut: checkOut || null,
    confirmation: confirmation || null,
    roomType: roomType || null,
    nights: nights ? Number(nights) : null,
    rate: rate || null
  };
}

/* ------------------------- CONTACTS PARSING ------------------------- */

function parseContactsFromContactInfo(contactBlock) {
  if (!contactBlock) return [];

  const labelDefs = [
    { group: "client_onsite", labels: ["CLIENT ONSITE CONTACT", "CLIENT ONSITE CONTACTS"] },
    { group: "lai_onsite", labels: ["LEADING AUTHORITIES ONSITE CONTACT", "LEADING AUTHORITIES ONSITE CONTACTS"] },
    { group: "lai_contacts", labels: ["LEADING AUTHORITIES CONTACTS", "LEADING AUTHORITIES\\s*CONTACTS"] },
    { group: "talent", labels: ["TALENT CONTACT"] }
  ];

  const chunks = sliceLabeledChunks(contactBlock, labelDefs);

  const out = [];
  for (const ch of chunks) {
    if (ch.group === "talent") out.push(...parseTalentContacts(ch.text));
    else out.push(...parsePeopleList(ch.text, ch.group));
  }

  return dedupeContacts(out);
}

function sliceLabeledChunks(block, labelDefs) {
  const hits = [];

  // find label occurrences (first match per label is usually enough; but we’ll take all)
  for (const def of labelDefs) {
    for (const rawLabel of def.labels) {
      const re = new RegExp(`\\b${rawLabel}\\b\\s*:\\s*`, "ig");
      let m;
      while ((m = re.exec(block))) {
        hits.push({ group: def.group, label: rawLabel, idx: m.index, len: m[0].length });
      }
    }
  }

  if (!hits.length) return [];

  hits.sort((a, b) => a.idx - b.idx);

  const chunks = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].idx + hits[i].len;
    const end = i + 1 < hits.length ? hits[i + 1].idx : block.length;
    const text = block.slice(start, end).trim();
    chunks.push({ group: hits[i].group, text });
  }
  return chunks;
}

function parsePeopleList(text, group) {
  const lines = String(text || "").split("\n").map(s => s.trim()).filter(Boolean);
  if (!lines.length) return [];

  // person starts often look like "First Last, Title"
  const blocks = [];
  let cur = [];
  for (const l of lines) {
    const newPerson = /^[A-Z][a-zA-Z'’.\- ]+,\s+/.test(l);
    if (newPerson && cur.length) {
      blocks.push(cur.join("\n"));
      cur = [l];
    } else {
      cur.push(l);
    }
  }
  if (cur.length) blocks.push(cur.join("\n"));

  // If we never detected a new person line, treat whole thing as one person block
  if (!blocks.length) blocks.push(lines.join("\n"));

  return blocks.map(b => parsePersonBlock(b, group)).filter(Boolean);
}

function parsePersonBlock(block, group) {
  const nameTitleLine = (block.split("\n")[0] || "").trim();
  if (!nameTitleLine) return null;

  const name = nameTitleLine.includes(",")
    ? nameTitleLine.split(",")[0].trim()
    : nameTitleLine.trim();

  const title = nameTitleLine.includes(",")
    ? nameTitleLine.split(",").slice(1).join(",").trim()
    : null;

  return {
    group,
    name: name || null,
    title: title || null,
    office: match1(block, /Office:\s*([0-9()\- ]{7,})/i),
    cell: match1(block, /Cell:\s*([0-9()\- ]{7,})/i) || match1(block, /Mobile:\s*([0-9()\- ]{7,})/i),
    email: match1(block, /Email:\s*([^\s]+@[^\s]+)/i),
    raw: block
  };
}

function parseTalentContacts(text) {
  const block = String(text || "").trim();
  if (!block) return [];

  // "Name (will be accompanied by X) Tom’s Cell: (...)"
  const primaryName = match1(block, /^(.+?)(?:\n|\(|$)/i);
  const companion = match1(block, /\(will be accompanied by ([^)]+)\)/i);

  const talentCell = match1(block, /\bCell:\s*([0-9()\- ]{7,})/i) || null;

  // Generic "<Name>'s Cell: (###) ###-####"
  const companionCell = match1(block, /[A-Z][a-zA-Z]+[’']s Cell:\s*([0-9()\- ]{7,})/i) || null;

  const out = [];
  out.push({
    group: "talent",
    name: primaryName || null,
    title: null,
    cell: talentCell,
    email: match1(block, /Email:\s*([^\s]+@[^\s]+)/i),
    companion: companion || null,
    raw: block
  });

  if (companion) {
    out.push({
      group: "talent_companion",
      name: companion,
      title: null,
      cell: companionCell,
      email: null,
      raw: block
    });
  }

  return out;
}

function dedupeContacts(list) {
  const seen = new Set();
  const out = [];
  for (const c of list || []) {
    const key = [
      (c.group || "").toLowerCase(),
      (c.name || "").toLowerCase(),
      (c.email || "").toLowerCase(),
      normalizePhone(c.cell || ""),
      normalizePhone(c.office || "")
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function normalizePhone(s) {
  return String(s || "").replace(/[^\d]+/g, "");
}

/* ------------------------- FLIGHTS ------------------------- */

function parseFlights(scheduleBlock) {
  const flights = [];

  // This is intentionally broad because some briefs do “Delta 1234” and others “DL 1234”.
  const re = /\b([A-Z]{2,}|[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\s+#?(\d{2,5})\b[\s\S]*?(?=\n\n|\b([A-Z]{2,}|[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\s+#?\d{2,5}\b|$)/g;

  let m;
  while ((m = re.exec(scheduleBlock))) {
    const raw = normalize(m[0]);
    flights.push({
      airline: String(m[1] || "").trim(),
      flightNumber: String(m[2] || "").trim(),
      reservationCode:
        match1(raw, /(?:Reservation Code|Airline Reservation Code):\s*([A-Z0-9]+)/i),
      seat: match1(raw, /\bSeat:\s*([A-Z0-9]+)/i) || match1(raw, /\bSeat\s+([A-Z0-9]+)\b/i),
      raw
    });
  }
  return flights;
}

/* ------------------------- CONFIDENCE ------------------------- */

function computeConfidence(x) {
  const score = (v) => (v ? 1 : 0);

  const headerScore =
    score(x.bookingNumber) +
    score(x.talentName) +
    score(x.clientName) +
    score(x.eventTitle) +
    score(x.eventDateText);

  const sitesScore = (x.sites || []).length ? 1 : 0;
  const contactsScore = (x.contacts || []).length ? 1 : 0;

  const total = headerScore + sitesScore + contactsScore;
  const max = 7;

  return {
    overall: Math.round((total / max) * 100),
    hasBookingNumber: !!x.bookingNumber,
    hasHeader: !!(x.talentName || x.clientName || x.eventTitle || x.eventDateText),
    hasSites: !!(x.sites || []).length,
    hasContacts: !!(x.contacts || []).length
  };
}

/* ------------------------- TEXT HELPERS ------------------------- */

function normalize(s) {
  return String(s || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function match1(text, re) {
  const m = String(text || "").match(re);
  return m ? String(m[1] ?? m[0]).trim() : null;
}

function matchBlock(text, re) {
  const m = String(text || "").match(re);
  return m ? String(m[1] || "").trim() : null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

