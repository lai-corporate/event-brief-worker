// ✅ Deploy-safe pdf.js loader (lazy import)
// - avoids Cloudflare deploy-time module evaluation crash
// - caches the import so only loads once per isolate
let _pdfjsPromise = null;

async function getPdfjs() {
  if (_pdfjsPromise) return _pdfjsPromise;

  // Minimal polyfills pdfjs sometimes expects
  globalThis.window ??= globalThis;
  globalThis.navigator ??= { userAgent: "CloudflareWorkers" };
  globalThis.location ??= new URL("https://example.com/");

  _pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return _pdfjsPromise;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OK");
    }

    // POST raw PDF bytes -> JSON
    if (request.method === "POST" && url.pathname === "/api/extract-all") {
      const buf = await request.arrayBuffer();
      if (!buf || buf.byteLength < 10) return json({ ok: false, error: "empty_body" }, 400);

      // ✅ Lazy-load pdfjs here
      const pdfjsLib = await getPdfjs();

      // ✅ Important: disableWorker in Workers runtime
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(buf),
        disableWorker: true
      });

      const pdf = await loadingTask.promise;

      // 1) Extract text from ALL pages
      const { rawText, pages } = await extractAllPagesText(pdf);

      // 2) Best-effort parse
      const parsed = parseLaiEventBrief(rawText);

      return json({ ok: true, parsed, pages, rawText });
    }

    return new Response("Not found", { status: 404 });
  }
};

// Updated: accept already-loaded pdf instance (avoids re-loading)
async function extractAllPagesText(pdf) {
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map(i => i.str).join(" ");
    pages.push({ page: p, text });
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

