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
            timingsMs: {
              readMs,
              extractMs,
              parseMs,
              totalMs
            }
          }
        };

        if (includePages) res.pages = pages;
        if (includeRaw) res.rawText = rawText;

        if (debug) {
          res.debug = {
            url: request.url,
            notes: "unpdf is pure JS; paging is best-effort if the PDF text has no page separators."
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

  // 2) "Page X of Y" markers (your Event Briefs have these inline)
  // Split BEFORE each "Page N of M" marker (except if it's at very start)
  const markerRe = /(?=\bPage\s+\d+\s+of\s+\d+\b)/gi;
  const markerChunks = text.split(markerRe).map(s => s.trim()).filter(Boolean);

  if (markerChunks.length >= 2) {
    // The first chunk might be "Page 2 of 4 ..." etc; treat each chunk as a page-ish segment.
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
 */
function parseLaiEventBrief(rawText) {
  const t = normalize(rawText);

  // Header fields
  const bookingNumber = match1(t, /Booking\s*#\s*(\d{5,12})/i);

  // Between divider and CONTACT INFORMATION we usually have:
  // talent, client, event name, date
  const headerBlock = matchBlock(t, /-\s*-\s*-\s*\n([\s\S]*?)\nCONTACT INFORMATION/i);
  let talentName = null, clientName = null, eventTitle = null, eventDateText = null;
  if (headerBlock) {
    const lines = headerBlock.split("\n").map(x => x.trim()).filter(Boolean);
    talentName = lines[0] || null;
    clientName = lines[1] || null;
    eventTitle = lines[2] || null;
    eventDateText = lines[3] || null;
  }

  // Grab full CONTACT INFORMATION block (newer template is label-driven)
  const contactInfoBlock = matchBlock(t, /CONTACT INFORMATION\s*([\s\S]*?)\nSCHEDULE OF EVENTS/i);

  // Helper to slice between labels
  function sectionBetween(block, startLabel, endLabel) {
    if (!block) return null;
    const re = new RegExp(`${startLabel}:\\s*([\\s\\S]*?)\\n${endLabel}:`, "i");
    const m = block.match(re);
    return m ? m[1].trim() : null;
  }
  function sectionToEnd(block, startLabel) {
    if (!block) return null;
    const re = new RegExp(`${startLabel}:\\s*([\\s\\S]*)$`, "i");
    const m = block.match(re);
    return m ? m[1].trim() : null;
  }

  // Venue/event site block supports both "EVENT SITE" and older "EVENT/HOTEL SITE"
  const eventSiteBlock =
    sectionBetween(contactInfoBlock, "EVENT SITE", "CLIENT ONSITE CONTACT") ||
    sectionBetween(contactInfoBlock, "EVENT\\/HOTEL SITE", "CLIENT ONSITE CONTACT");

  const clientOnsiteBlock =
    sectionBetween(contactInfoBlock, "CLIENT ONSITE CONTACT", "LEADING AUTHORITIES\\s*CONTACTS") ||
    sectionBetween(contactInfoBlock, "CLIENT ONSITE CONTACT", "LEADING AUTHORITIES CONTACTS");

  const laiContactsBlock =
    sectionBetween(contactInfoBlock, "LEADING AUTHORITIES\\s*CONTACTS", "TALENT CONTACT") ||
    sectionBetween(contactInfoBlock, "LEADING AUTHORITIES CONTACTS", "TALENT CONTACT");

  // Talent contact sometimes ends with "**Day of, Urgent Use Only**"
  const talentBlock =
    sectionBetween(contactInfoBlock, "TALENT CONTACT", "\\*\\*Day of, Urgent Use Only\\*\\*") ||
    sectionToEnd(contactInfoBlock, "TALENT CONTACT");

  // Build venue
  const venueName = eventSiteBlock ? match1(eventSiteBlock, /^(.+?)\n/) : null;

  const venue = eventSiteBlock ? {
    raw: eventSiteBlock,
    name: venueName,
    phone: match1(eventSiteBlock, /Phone:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
    address: (() => {
      const lines = eventSiteBlock.split("\n").map(s => s.trim()).filter(Boolean);
      // Usually: name, street, city/state/zip, Phone...
      return lines.slice(0, 3).join(", ");
    })()
  } : null;

  // Client onsite contact
  const clientOnsite = clientOnsiteBlock ? {
    raw: clientOnsiteBlock,
    nameTitle: match1(clientOnsiteBlock, /^(.+?)(?:\nOffice:|\nCell:|\nEmail:|$)/i),
    office: match1(clientOnsiteBlock, /Office:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
    cell: match1(clientOnsiteBlock, /Cell:\s*([0-9()\- ]{7,})/i),
    email: match1(clientOnsiteBlock, /Email:\s*([^\s]+@[^\s]+)/i),
  } : null;

  // LAI contacts (may be multiple)
  const laiContacts = [];
  if (laiContactsBlock) {
    const chunks = laiContactsBlock
      .split(/\n(?=[A-Z][a-zA-Z]+.*?,\s)/)
      .map(s => s.trim())
      .filter(Boolean);

    for (const c of chunks) {
      laiContacts.push({
        raw: c,
        nameTitle: match1(c, /^(.+?)(?:\nOffice:|$)/i),
        office: match1(c, /Office:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
        cell: match1(c, /Cell:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
      });
    }
  }

  // Talent contact
  const talentContact = talentBlock ? {
    raw: talentBlock,
    name: match1(talentBlock, /^(.+?)\n/i),
    cell: match1(talentBlock, /Cell:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
  } : null;

  // Emergency block (best-effort)
  const emergencyBlock = matchBlock(t, /EMERGENCY TRAVEL\s*NUMBERS:\s*([\s\S]*?)(?:\n=== PAGE 2 ===|\nSCHEDULE OF EVENTS|$)/i);
  const emergencyTravel = emergencyBlock ? {
    raw: emergencyBlock,
    phone: match1(emergencyBlock, /Phone:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
  } : null;

  // Schedule section (best-effort)
  const scheduleBlock = matchBlock(t, /SCHEDULE OF EVENTS\s*([\s\S]*?)\n- - -\nEVENT DETAILS/i);
  const flights = [];
  if (scheduleBlock) {
    const re = /\b([A-Z]{2})\s+(\d{3,5})\b[\s\S]*?(?=\n\n|\b[A-Z]{2}\s+\d{3,5}\b|$)/g;
    let m;
    while ((m = re.exec(scheduleBlock))) {
      const raw = normalize(m[0]);
      flights.push({
        airline: m[1],
        flightNumber: m[2],
        raw,
        reservationCode: match1(raw, /Reservation Code:\s*([A-Z0-9]+)/i),
        seat: match1(raw, /Seat\s*([A-Z0-9]+)/i)
      });
    }
  }

  const eventDetails = matchBlock(t, /EVENT DETAILS\s*([\s\S]*?)\n- - -/i) || null;
  const clientDetails = matchBlock(t, /CLIENT DETAILS\s*([\s\S]*?)\n- - -/i) || null;
  const talentIntro = matchBlock(t, /TALENT INTRODUCTION\s*([\s\S]*?)$/i) || null;

  return {
    bookingNumber,
    talentName,
    clientName,
    eventTitle,
    eventDateText,
    venue,
    contacts: { clientOnsite, laiContacts, talentContact, emergencyTravel },
    schedule: scheduleBlock ? { raw: scheduleBlock, flights } : null,
    eventDetails,
    clientDetails,
    talentIntroduction: talentIntro
  };
}

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
  return m ? (m[1] || m[0]).toString().trim() : null;
}

function matchBlock(text, re) {
  const m = String(text || "").match(re);
  return m ? (m[1] || "").toString().trim() : null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
