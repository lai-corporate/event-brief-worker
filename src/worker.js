console.log("✅ worker module evaluated", new Date().toISOString());

// ✅ Deploy-safe pdf.js loader (lazy import) for Cloudflare Workers
let _pdfjsPromise = null;

async function getPdfjs() {
  if (_pdfjsPromise) return _pdfjsPromise;

  _pdfjsPromise = (async () => {
    // ✅ pdfjs-dist 3.x legacy build is .js (not .mjs)
    const mod = await import("pdfjs-dist/legacy/build/pdf.js");
    const pdfjs = mod?.default ?? mod;

    // ✅ Ensure pdf.js does NOT try to load/spawn pdf.worker
    try {
      if (pdfjs?.GlobalWorkerOptions) {
  // pdfjs 3.x REQUIRES a workerSrc, even if workers are disabled
  pdfjs.GlobalWorkerOptions.workerSrc = "data:application/javascript,";
}

    } catch (_) {}

    return pdfjs;
  })();

  return _pdfjsPromise;
}


export default {
  async fetch(request) {

     // ✅ PROVE fetch is entered
    console.log("✅ fetch entered", request.method, request.url);
    const url = new URL(request.url);
    const qp = url.searchParams;

    const requestId =
      (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2));

    const debug = qp.get("debug") === "1" || qp.get("debug") === "true";

    // Performance knobs (defaults are FLOW-friendly)
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

    // POST PDF -> JSON
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

        // Lazy-load pdfjs
        const tPdfjs0 = Date.now();
        const pdfjsLib = await getPdfjs();
        const pdfjsImportMs = Date.now() - tPdfjs0;

        // Load PDF
        const tLoad0 = Date.now();
       const loadingTask = pdfjsLib.getDocument({
  data: pdfBytes,
  worker: null // ✅ REQUIRED in pdfjs-dist 3.x
});


        const pdf = await loadingTask.promise;
        const pdfLoadMs = Date.now() - tLoad0;

        const totalPages = pdf.numPages;
        const extractedPages = Math.min(totalPages, maxPages);

        log("pdf loaded", { totalPages, extractedPages, pdfjsImportMs, pdfLoadMs });

        // Extract text (capped)
        const tExtract0 = Date.now();
        const { rawText, pages } = await extractPagesText(pdf, extractedPages);
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
            totalPages,
            extractedPages,
            timingsMs: {
              readMs,
              pdfjsImportMs,
              pdfLoadMs,
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
            notes: "Enable raw/pages with ?raw=1&pages=1. Default is optimized for Flow."
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

// Reads either raw bytes OR Power Automate JSON wrapper { $content }
async function readPdfBytes(request, contentType, log) {
  // If Flow accidentally sends JSON (Power Automate wrapper), handle it.
  if (contentType.includes("application/json")) {
    const j = await request.json();
    const b64 = j?.$content || j?.content || null;
    if (!b64) return null;

    log("json wrapper detected", { hasContent: !!b64, contentType });
    return base64ToUint8Array(b64);
  }

  // Raw bytes path (preferred)
  const buf = await request.arrayBuffer();
  return new Uint8Array(buf);
}

function base64ToUint8Array(b64) {
  // b64 may include data-url prefix; strip if present
  const clean = String(b64 || "").replace(/^data:.*?;base64,/, "");
  const bin = atob(clean);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Extract only N pages (already loaded pdf)
async function extractPagesText(pdf, maxPages) {
  const pages = [];
  for (let p = 1; p <= maxPages; p++) {
    const t0 = Date.now();
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map(i => i.str).join(" ");
    pages.push({ page: p, text, ms: Date.now() - t0 });
  }
  const rawText = pages.map(x => `\n\n=== PAGE ${x.page} ===\n${x.text}`).join("");
  return { rawText, pages };
}

/**
 * Parse fields we can reliably pull from LAI Event Brief PDFs
 * (still returns rawText so you never lose data)
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

  // Venue/hotel site block
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

  // Contacts blocks
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
    const chunks = laiContactsBlock.split(/\n(?=[A-Z][a-zA-Z]+.*?,\s)/).map(s => s.trim()).filter(Boolean);
    for (const c of chunks) {
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
