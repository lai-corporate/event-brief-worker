import { extractText } from "unpdf";

export default {
  async fetch(request) {
    console.log("✅ fetch entered", request.method, request.url);

    const url = new URL(request.url);
    const qp = url.searchParams;

    const requestId =
      globalThis.crypto?.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + "-" + Math.random().toString(16).slice(2);

    const debug = qp.get("debug") === "1" || qp.get("debug") === "true";

    const maxPages = clampInt(qp.get("maxPages"), 1, 25, 10);
    const includeRaw = qp.get("raw") === "1";
    const includePages = qp.get("pages") === "1";
    const filename = qp.get("filename") || qp.get("name") || null;

    const t0 = Date.now();

    const log = (...args) => {
      if (debug) console.log(`[${requestId}]`, ...args);
    };

    const errlog = (...args) => {
      console.error(`[${requestId}]`, ...args);
    };

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "LAI Contract PDF Extractor",
        endpoints: ["POST /api/extract-all"]
      });
    }

    if (request.method === "POST" && url.pathname === "/api/extract-all") {
      try {
        const ct = (request.headers.get("content-type") || "").toLowerCase();

        log("incoming", {
          method: request.method,
          path: url.pathname,
          ct,
          maxPages,
          includeRaw,
          includePages,
          filename
        });

        const tRead0 = Date.now();
        const pdfBytes = await readPdfBytes(request, ct, log);
        const readMs = Date.now() - tRead0;

        if (!pdfBytes || pdfBytes.length < 10) {
          return json(
            {
              ok: false,
              error: "empty_body",
              message: "No PDF bytes were found in the request body.",
              meta: { requestId }
            },
            400
          );
        }

        const tExtract0 = Date.now();
        const result = await extractText(pdfBytes);
        const fullText = normalize(String(result?.text || ""));
        const { rawText, pages, extractedPages } = buildPagedText(fullText, maxPages);
        const extractMs = Date.now() - tExtract0;

        const tParse0 = Date.now();
        const parsed = parseLaiContractPdf(rawText, { filename });
        const parseMs = Date.now() - tParse0;

        const totalMs = Date.now() - t0;

        const res = {
          ok: true,
          parsed,
          meta: {
            requestId,
            filename,
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
            parser: "contract_only",
            note: "Event brief parsing was removed. This worker now only extracts Talent and Client contract PDFs."
          };
        }

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

    return json(
      {
        ok: false,
        error: "not_found",
        message: "Use POST /api/extract-all"
      },
      404
    );
  }
};

// -----------------------------
// Main Contract Parser
// -----------------------------

function parseLaiContractPdf(rawText, opts = {}) {
  const t = normalize(rawText);
  const filename = opts.filename || "";

  const bookingNumber =
    match1(t, /Booking\s*#\s*(\d{5,12})/i) ||
    match1(filename, /_(\d{5,12})(?:\D|$)/i) ||
    match1(filename, /\b(\d{5,12})\b/i) ||
    null;

  const isTalentAgreement =
    /Agreement For Talent Services/i.test(t) ||
    /Accepted by Talent/i.test(t) ||
    /Net Talent Fee/i.test(t) ||
    /_T_/i.test(filename);

  const isClientAgreement =
    /Accepted by Client/i.test(t) ||
    /Speaker Fee/i.test(t) ||
    /Host Organization/i.test(t) ||
    /_C_/i.test(filename);

  if (isTalentAgreement) {
    return parseTalentContract(t, { filename, bookingNumber });
  }

  if (isClientAgreement) {
    return parseClientContract(t, { filename, bookingNumber });
  }

  return {
    documentType: "unknown_contract_pdf",
    bookingNumber,
    needsReview: true,
    confidence: {
      overall: 10,
      reason: "PDF text extracted, but it did not match Talent Agreement or Client Agreement patterns."
    }
  };
}

// -----------------------------
// Talent Contract Parser
// -----------------------------

function parseTalentContract(t, ctx = {}) {
  const netTalentFeeText = match1(t, /N\.\s*Net Talent Fee:\s*([$€£]?\s*[0-9,]+(?:\.\d{2})?)/i);

  const signedByTalent =
    /Document e-signed by/i.test(t) ||
    /Accepted by Talent/i.test(t) ||
    /Signature Date:/i.test(t);

  const parsed = {
    documentType: "talent_contract",
    bookingNumber: ctx.bookingNumber || null,
    filename: ctx.filename || null,

    clientName: cleanLine(match1(t, /A\.\s*Client:\s*([^\n]+)/i)),
    clientAddress: cleanLong(match1(t, /A\.\s*Client:\s*[\s\S]*?\n([\s\S]*?)\nB\.\s*Primary Contact:/i)),

    primaryContact: cleanLine(match1(t, /B\.\s*Primary Contact:\s*([^\n]+)/i)),
    primaryContactPhone: cleanLine(match1(t, /B\.\s*Primary Contact:[\s\S]*?Phone:\s*([^\n]+)/i)),

    talentName: cleanLine(match1(t, /C\.\s*Talent:\s*([^\n]+)/i)),

    laiContact: cleanLine(match1(t, /D\.\s*LAI Contact:\s*([^\n]+)/i)),
    laiContactOffice: cleanLine(match1(t, /D\.\s*LAI Contact:[\s\S]*?Office:\s*([^\n]+)/i)),
    laiContactCell: cleanLine(match1(t, /D\.\s*LAI Contact:[\s\S]*?Cell:\s*([^\n]+)/i)),

    dateOfAppearance: cleanLine(match1(t, /E\.\s*Date of Appearance:\s*([^\n]+)/i)),
    eventTimetable: cleanLong(match1(t, /F\.\s*Event Timetable:\s*([\s\S]*?)\nG\.\s*Additional/i)),
    additionalActivitiesDeliverables: cleanLong(match1(t, /G\.\s*Additional\s*Activities\/Deliverables:\s*([\s\S]*?)\nH\.\s*Event Name:/i)),

    eventName: cleanLine(match1(t, /H\.\s*Event Name:\s*([^\n]+)/i)),
    speechTitle: cleanLong(match1(t, /I\.\s*Speech Title:\s*([\s\S]*?)\nJ\.\s*Audience Description:/i)),
    audienceDescription: cleanLong(match1(t, /J\.\s*Audience Description:\s*([\s\S]*?)\nK\.\s*Required Attire:/i)),
    requiredAttire: cleanLine(match1(t, /K\.\s*Required Attire:\s*([^\n]+)/i)),

    eventLocation: parseSimpleAddressBlock(
      match1(t, /L\.\s*Event Location:\s*([\s\S]*?)\nM\.\s*Accommodations:/i)
    ),

    accommodations: parseSimpleAddressBlock(
      match1(t, /M\.\s*Accommodations:\s*([\s\S]*?)\nN\.\s*Net Talent Fee:/i)
    ),

    netTalentFeeText,
    netTalentFee: moneyToNumber(netTalentFeeText),

    expenseDescription: cleanLong(match1(t, /O\.\s*Expense Description:\s*([\s\S]*?)\nP\.\s*A\/V Requirements:/i)),
    avRequirements: cleanLong(match1(t, /P\.\s*A\/V Requirements:\s*([\s\S]*?)\nQ\.\s*Travel Agreement:/i)),
    travelAgreement: cleanLong(match1(t, /Q\.\s*Travel Agreement:\s*([\s\S]*?)\nR\.\s*Arrival:/i)),
    arrival: cleanLong(match1(t, /R\.\s*Arrival:\s*([\s\S]*?)\nS\.\s*Air Travel:/i)),
    airTravel: cleanLong(match1(t, /S\.\s*Air Travel:\s*([\s\S]*?)(?:\nT\.\s*Recording:|\nAccepted by Leading Authorities|$)/i)),
    recording: cleanLong(match1(t, /T\.\s*Recording:\s*([\s\S]*?)(?:\nAnthony S\. Fauci|\nAccepted by Leading Authorities|\nPage\s+\d+|$)/i)),

    signature: {
      signedByTalent,
      signerName:
        cleanLine(match1(t, /Signer\s+[^@\n]*entered name at signing as\s*([^\n]+)/i)) ||
        cleanLine(match1(t, /Document e-signed by\s*([^(]+)\s*\(/i)),
      signerEmail: cleanLine(match1(t, /Document e-signed by\s*.*?\(([^)]+@[^)]+)\)/i)),
      signatureDate: cleanLine(match1(t, /Signature Date:\s*([^\n]+)/i)),
      auditStatus: cleanLine(match1(t, /Status:\s*([^\n]+)/i)),
      transactionId: cleanLine(match1(t, /Transaction ID:\s*([^\n]+)/i))
    }
  };

  parsed.confidence = computeContractConfidence(parsed, [
    "bookingNumber",
    "clientName",
    "talentName",
    "dateOfAppearance",
    "eventName",
    "netTalentFee"
  ]);

  return parsed;
}

// -----------------------------
// Client Contract Parser
// -----------------------------

function parseClientContract(t, ctx = {}) {
  const speakerFeeText = match1(t, /Speaker Fee:\s*([$€£]?\s*[0-9,]+(?:\.\d{2})?)/i);

  const parsed = {
    documentType: "client_contract",
    bookingNumber: ctx.bookingNumber || null,
    filename: ctx.filename || null,

    hostOrganization: cleanLine(match1(t, /Host Organization:\s*([^\n]+)/i)),
    eventName: cleanLine(match1(t, /Event Name:\s*([^\n]+)/i)),
    eventDate: cleanLine(match1(t, /Date:\s*([^\n]+)/i)),

    locationAndVenue: parseSimpleAddressBlock(
      match1(t, /Location and Venue:\s*([\s\S]*?)\nHotel Accommodations:/i)
    ),

    hotelAccommodations: parseSimpleAddressBlock(
      match1(t, /Hotel Accommodations:\s*([\s\S]*?)\nSpeaker Fee:/i)
    ),

    speakerFeeText,
    speakerFee: moneyToNumber(speakerFeeText),

    expenseDescription: cleanLong(match1(t, /Expense Description:\s*([\s\S]*?)\nTimeline of Events:/i)),
    timelineOfEvents: cleanLong(match1(t, /Timeline of Events:\s*([\s\S]*?)\nAdditional Requested/i)),
    additionalRequestedActivities: cleanLong(match1(t, /Additional Requested\s*Activities:\s*([\s\S]*?)\nRequested Speech Topic:/i)),
    requestedSpeechTopic: cleanLong(match1(t, /Requested Speech Topic:\s*([\s\S]*?)\nEvent Promotions:/i)),

    eventPromotions: cleanLong(
      match1(t, /Event Promotions:\s*([\s\S]*?)(?:\nIf applicable|\nWill event be recorded\?)/i)
    ),

    mediaInterviews: cleanLong(
      match1(t, /requests for\s*media interviews\s*\(advance and on-site\):\s*([\s\S]*?)\nWill event be recorded\?/i)
    ),

    willEventBeRecorded: cleanLong(match1(t, /Will event be recorded\?\s*([\s\S]*?)\nIf requesting recording/i)),
    recordingPurpose: cleanLong(match1(t, /purpose of the recording:\s*([\s\S]*?)\nAudience Profile:/i)),
    audienceProfile: cleanLong(match1(t, /Audience Profile:\s*([\s\S]*?)\nAttire/i)),
    attire: cleanLine(match1(t, /Attire\s*\(speaker\/audience\):\s*([^\n]+)/i)),
    eventSessionSponsors: cleanLong(match1(t, /Event\/Session Sponsors:\s*([\s\S]*?)\nSecurity:/i)),
    security: cleanLong(match1(t, /Security:\s*([\s\S]*?)\nBy signing this agreement/i)),

    cancellationTerms: {
      depositDueText: cleanLong(match1(t, /non-refundable deposit equal(?:ing)?\s*([\s\S]*?)\./i)),
      balanceDueText: cleanLong(match1(t, /remaining balance of the fee will be due\s*([\s\S]*?)\./i)),
      nonRefundableText: cleanLong(match1(t, /non-refundable within\s*([\s\S]*?)\./i))
    },

    signature: {
      clientSignerName: cleanLine(match1(t, /Accepted by Client[\s\S]*?Name:\s*([^\n]+)/i)),
      clientSignerTitle: cleanLine(match1(t, /Accepted by Client[\s\S]*?Title:\s*([^\n]+)/i)),
      clientSignatureDate: cleanLine(match1(t, /Accepted by Client[\s\S]*?Date:\s*([^\n]+)/i)),
      signedByClient: /Accepted by Client/i.test(t) && /Signature:/i.test(t)
    }
  };

  parsed.confidence = computeContractConfidence(parsed, [
    "bookingNumber",
    "hostOrganization",
    "eventName",
    "eventDate",
    "speakerFee"
  ]);

  return parsed;
}

// -----------------------------
// Request / PDF Helpers
// -----------------------------

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function readPdfBytes(request, contentType, log) {
  if (contentType.includes("application/json")) {
    const j = await request.json();

    const b64 =
      j?.$content ||
      j?.content ||
      j?.body?.$content ||
      j?.file?.content ||
      j?.fileContent ||
      null;

    if (!b64) return null;

    log("json wrapper detected", {
      hasContent: !!b64,
      contentType
    });

    return base64ToUint8Array(b64);
  }

  const buf = await request.arrayBuffer();
  return new Uint8Array(buf);
}

function base64ToUint8Array(b64) {
  const clean = String(b64 || "")
    .replace(/^data:.*?;base64,/, "")
    .replace(/\s+/g, "");

  const bin = atob(clean);
  const arr = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) {
    arr[i] = bin.charCodeAt(i);
  }

  return arr;
}

function buildPagedText(fullText, maxPages) {
  const text = String(fullText || "").trim();

  const ffChunks = text.split("\f").map(s => s.trim()).filter(Boolean);

  if (ffChunks.length >= 2) {
    const take = Math.min(ffChunks.length, maxPages);

    const pages = ffChunks.slice(0, take).map((pageText, i) => ({
      page: i + 1,
      text: pageText,
      ms: 0
    }));

    const rawText = pages
      .map(x => `\n\n=== PAGE ${x.page} ===\n${x.text}`)
      .join("");

    return {
      rawText,
      pages,
      extractedPages: pages.length
    };
  }

  const markerRe = /(?=\bPage\s+\d+\s+of\s+\d+\b)/gi;
  const markerChunks = text.split(markerRe).map(s => s.trim()).filter(Boolean);

  if (markerChunks.length >= 2) {
    const take = Math.min(markerChunks.length, maxPages);

    const pages = markerChunks.slice(0, take).map((pageText, i) => ({
      page: i + 1,
      text: pageText,
      ms: 0
    }));

    const rawText = pages
      .map(x => `\n\n=== PAGE ${x.page} ===\n${x.text}`)
      .join("");

    return {
      rawText,
      pages,
      extractedPages: pages.length
    };
  }

  const pages = [
    {
      page: 1,
      text,
      ms: 0
    }
  ];

  return {
    rawText: `\n\n=== PAGE 1 ===\n${text}`,
    pages,
    extractedPages: 1
  };
}

// -----------------------------
// Parsing Helpers
// -----------------------------

function parseSimpleAddressBlock(block) {
  const raw = cleanLong(block);
  if (!raw) {
    return {
      name: null,
      address: null,
      phone: null,
      raw: null
    };
  }

  const phone = cleanLine(match1(raw, /Phone:\s*([0-9()\-.\s]{7,})/i));

  const noPhone = raw.replace(/Phone:\s*[0-9()\-.\s]{7,}/i, "").trim();

  const parts = noPhone
    .split(/\n|,\s*(?=\d{3,6}\s|\b[A-Z][a-z]+,\s*[A-Z]{2}\b)/)
    .map(x => x.trim())
    .filter(Boolean);

  const name = parts[0] || null;
  const address = parts.length > 1 ? parts.slice(1).join(", ") : noPhone || null;

  return {
    name,
    address,
    phone,
    raw
  };
}

function computeContractConfidence(obj, keys) {
  const total = keys.length;
  let hit = 0;

  for (const k of keys) {
    if (obj[k] !== null && obj[k] !== undefined && obj[k] !== "") hit++;
  }

  const overall = total ? Math.round((hit / total) * 100) : 0;

  return {
    overall,
    matchedFields: hit,
    totalFields: total,
    missingFields: keys.filter(k => obj[k] === null || obj[k] === undefined || obj[k] === "")
  };
}

function normalize(s) {
  return String(s || "")
    .replace(/\r/g, "")
    .replace(/\uFFFE/g, "")
    .replace(/\uFEFF/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanLine(v) {
  if (!v) return null;

  const s = String(v)
    .replace(/\s+/g, " ")
    .trim();

  return s || null;
}

function cleanLong(v) {
  if (!v) return null;

  const s = String(v)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return s || null;
}

function match1(text, re) {
  const m = String(text || "").match(re);
  return m ? String(m[1] ?? m[0]).trim() : null;
}

function moneyToNumber(v) {
  if (!v) return null;

  const n = Number(
    String(v)
      .replace(/[$€£,]/g, "")
      .trim()
  );

  return Number.isFinite(n) ? n : null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

