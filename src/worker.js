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

        // unpdf expects ArrayBuffer/Uint8Array. We give Uint8Array.
        // It returns a result with text and sometimes page grouping depending on version.
        const result = await extractText(pdfBytes);

        // Normalize into our format
        const fullText = normalize(String(result?.text || ""));

        // If we need pages, best-effort split:
        // unpdf doesn’t always return per-page segmentation; we emulate “page 1..N” by
        // splitting on formfeed or using a chunk heuristic.
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

function buildPagedText(fullText, maxPages) {
  // Some PDFs include formfeed separators \f between pages.
  const chunks = fullText.split("\f").map(s => s.trim()).filter(Boolean);

  let pages = [];
  if (chunks.length >= 2) {
    const take = Math.min(chunks.length, maxPages);
    pages = chunks.slice(0, take).map((text, idx) => ({ page: idx + 1, text, ms: 0 }));
  } else {
    // Fallback: no page separators. Treat everything as page 1.
    pages = [{ page: 1, text: fullText, ms: 0 }];
  }

  const rawText = pages.map(x => `\n\n=== PAGE ${x.page} ===\n${x.text}`).join("");
  return { rawText, pages, extractedPages: pages.length };
}

function parseLaiEventBrief(rawText) {
  const t = normalize(rawText);

  const bookingNumber = match1(t, /Booking\s*#\s*(\d{5,12})/i);

  const headerBlock = matchBlock(t, /-\s*-\s*-\s*\n([\s\S]*?)\nCONTACT INFORMATION/i);
  let talentName = null, clientName = null, eventTitle = null, eventDateText = null;
  if (headerBlock) {
    const lines = headerBlock.split("\n").map(x => x.trim()).filter(Boolean);
    talentName = lines[0] || null;
    clientName = lines[1] || null;
    eventTitle = lines[2] || null;
    eventDateText = lines[3] || null;
  }

  const venueBlock = matchBlock(t, /EVENT\/HOTEL SITE:\s*([\s\S]*?)\nCLIENT ONSITE CONTACT:/i);
  const venueName = venueBlock ? match1(venueBlock, /^(.+?)\n/) : null;

  const venue = venueBlock ? {
    raw: venueBlock,
    name: venueName,
    phone: match1(venueBlock, /Phone:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
    nights: match1(venueBlock, /(\d+)\s+nights?\s+stay/i),
    checkIn: match1(venueBlock, /Check-in date:\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i),
    checkOut: match1(venueBlock, /Check-out date:\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i),
    confirmationNumber: match1(venueBlock, /Confirmation number:\s*([0-9]+)/i),
    billingNotes: matchBlock(venueBlock, /Confirmation number:.*?\n([\s\S]*?)$/i) || null
  } : null;

  const clientOnsiteBlock = matchBlock(t, /CLIENT ONSITE CONTACT:\s*([\s\S]*?)\nLEADING AUTHORITIES\s*CONTACTS:/i);
  const clientOnsite = clientOnsiteBlock ? {
    raw: clientOnsiteBlock,
    nameTitle: match1(clientOnsiteBlock, /^(.+?)(?:\nOffice:|\nCell:|\nEmail:|$)/i),
    office: match1(clientOnsiteBlock, /Office:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
    cell: match1(clientOnsiteBlock, /Cell:\s*([0-9()\- ]{7,})/i),
    email: match1(clientOnsiteBlock, /Email:\s*([^\s]+@[^\s]+)/i),
  } : null;

  const laiContactsBlock = matchBlock(t, /LEADING AUTHORITIES\s*CONTACTS:\s*([\s\S]*?)\nTALENT CONTACT:/i);
  const laiContacts = [];
  if (laiContactsBlock) {
    const chunks2 = laiContactsBlock.split(/\n(?=[A-Z][a-zA-Z]+.*?,\s)/).map(s => s.trim()).filter(Boolean);
    for (const c of chunks2) {
      laiContacts.push({
        raw: c,
        nameTitle: match1(c, /^(.+?)(?:\nOffice:|$)/i),
        office: match1(c, /Office:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
        cell: match1(c, /Cell:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
      });
    }
  }

  const talentBlock = matchBlock(t, /TALENT CONTACT:\s*([\s\S]*?)\nEMERGENCY TRAVEL/i);
  const talentContact = talentBlock ? {
    raw: talentBlock,
    name: match1(talentBlock, /^(.+?)\n/i),
    cell: match1(talentBlock, /Cell:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
  } : null;

  const emergencyBlock = matchBlock(t, /EMERGENCY TRAVEL\s*NUMBERS:\s*([\s\S]*?)(?:\n=== PAGE 2 ===|\nSCHEDULE OF EVENTS|$)/i);
  const emergencyTravel = emergencyBlock ? {
    raw: emergencyBlock,
    phone: match1(emergencyBlock, /Phone:\s*(\(\d{3}\)\s*\d{3}-\d{4})/i),
  } : null;

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


