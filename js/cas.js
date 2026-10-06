// Reads a CAMS / KFintech detailed CAS (PDF) in the browser and pulls out folios, schemes and
// transactions. Nothing is uploaded: the PDF is opened with pdf.js and parsed here.
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
// "05-Jan-2024" -> "2024-01-05"
const casDate = (s) => {
  const [d, m, y] = s.split('-');
  return `${y}-${MONTHS[m.toLowerCase()]}-${d.padStart(2, '0')}`;
};
// "1,234.50" -> 1234.5, "(1,234.50)" -> -1234.5
const casNum = (s) => (s.startsWith('(') ? -1 : 1) * +s.replace(/[(),]/g, '');
export const normFolio = (s) => String(s).replace(/\s+/g, '').toUpperCase();

// ---------- PDF -> lines of text ----------
export async function pdfLines(data, password) {
  const pdfjs = await import(`${PDFJS}pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc ||= `${PDFJS}pdf.worker.min.mjs`;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, password: password || undefined }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') {
      throw new Error(password ? 'That password didn’t open the PDF. It’s the one you chose when requesting the statement.' : 'This PDF is password-protected. Enter the password you chose when requesting the statement.');
    }
    throw new Error('Couldn’t open that file as a PDF.');
  }
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    lines.push(...textLines(items));
  }
  await doc.destroy();
  return lines;
}

// Group pdf.js text items into visual lines (same baseline), left to right.
export function textLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
    if (!row) rows.push((row = { y, items: [] }));
    row.items.push({ x, w: it.width || 0, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.items.sort((a, b) => a.x - b.x);
    let out = '', end = -Infinity;
    for (const it of r.items) {
      out += (out && it.x - end > 1 ? ' ' : '') + it.s;
      end = it.x + it.w;
    }
    return out.replace(/\s+/g, ' ').trim();
  });
}

// ---------- lines -> folios ----------
const DATE_RE = /^(\d{2}-[A-Za-z]{3}-\d{4})\s+(.*)$/;
const NUM = /^\(?-?[\d,]+\.\d+\)?$/;
const FOLIO_RE = /Folio\s+No\s*:\s*([A-Z0-9]+(?:\s*\/\s*[A-Z0-9]+)?)/i;
const ISIN_RE = /ISIN\s*:\s*(IN[A-Z0-9]{10})/i;
const BARE_ISIN_RE = /\b(INF[A-Z0-9]{9})\b/;
const OPEN_RE = /Opening\s+Unit\s+Balance\s*:?\s*(\(?[\d,]+\.\d+\)?)/i;
const CLOSE_RE = /Closing\s+Unit\s+Balance\s*:?\s*(\(?[\d,]+\.\d+\)?)/i;
const PERIOD_RE = /(\d{2}-[A-Za-z]{3}-\d{4})\s+To\s+(\d{2}-[A-Za-z]{3}-\d{4})/i;
const SCHEME_START_RE = /^[A-Z0-9]{1,12}-\S/;
const HOLDER_RE = /^[A-Z][A-Za-z .'&-]{1,60}$/;
const TAX_RE = /stamp\s*duty|\bstt\b|\btds\b/i;

// Split a transaction line into its description and the trailing numeric columns.
function splitNums(rest) {
  const toks = rest.split(' ');
  const nums = [];
  while (toks.length && NUM.test(toks[toks.length - 1])) nums.unshift(toks.pop());
  return { desc: toks.join(' '), nums };
}

// Scheme name as printed: drop the RTA code prefix and everything from "ISIN" on.
function schemeName(header) {
  return header
    .replace(/^[A-Z0-9]{1,12}-/, '')
    .replace(/\s*-?\s*ISIN\s*:.*$/i, '')
    .replace(/\(\s*(Non-Demat|Demat|Advisor)[^)]*\)?/gi, '')
    .replace(/\s+-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseCas(lines) {
  const folios = new Map();
  let period = null;
  let folio = null, scheme = null, holderNext = false;
  let pending = null; // a dated line whose numbers may be on the next line

  const round = (v, dp) => +v.toFixed(dp);

  function addTxn(date, desc, nums) {
    if (!scheme) return;
    const txns = scheme.txns;
    if (nums.length >= 3) {
      // amount, units, [price,] balance
      const amount = casNum(nums[0]), units = casNum(nums[1]);
      if (units === 0) return;
      txns.push({ date, amount: round(amount, 2), units: round(units, 4) });
      scheme.unitSum += units;
    } else if (nums.length === 1) {
      const amt = casNum(nums[0]);
      if (TAX_RE.test(desc)) {
        // Stamp duty is paid on top of a purchase; STT/TDS come out of a redemption.
        // Either way the cash that left (or reached) the investor shifts by +amt.
        // A reversed purchase has its stamp duty reversed too, printed negative: "(25.00)".
        const t = [...txns].reverse().find((x) => x.date === date);
        if (t) t.amount = round(t.amount + amt, 2);
      } else if (/div|idcw/i.test(desc) && !/reinv/i.test(desc)) {
        txns.push({ date, amount: -round(Math.abs(amt), 2), units: 0 }); // payout to the investor
      }
    } else if (nums.length === 2) {
      scheme.skipped++;
    }
  }

  function flushPending() {
    if (pending && pending.nums.length) addTxn(pending.date, pending.desc, pending.nums);
    pending = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!period) {
      const pm = line.match(PERIOD_RE);
      if (pm) period = { from: casDate(pm[1]), to: casDate(pm[2]) };
    }

    const fm = !DATE_RE.test(line) && line.match(FOLIO_RE);
    if (fm) {
      flushPending();
      const no = normFolio(fm[1]);
      if (!folios.has(no)) folios.set(no, { folioNo: no, holder: '', schemes: [] });
      folio = folios.get(no);
      scheme = null;
      holderNext = true;
      continue;
    }
    if (!folio) continue;

    // Holder name sits on the line after "Folio No:".
    if (holderNext) {
      holderNext = false;
      if (!folio.holder && HOLDER_RE.test(line) && !/ISIN|Registrar|Advisor/i.test(line)) {
        folio.holder = line;
        continue;
      }
    }

    // Scheme header: "B205-Axis ELSS Tax Saver Fund - Direct Growth - ISIN: INF846K01EW2(Advisor: DIRECT) Registrar : KFINTECH"
    // It can wrap: name on the line before, or the ISIN code on the line after.
    if (!DATE_RE.test(line) && (/ISIN\s*:/i.test(line) || (BARE_ISIN_RE.test(line) && SCHEME_START_RE.test(line)))) {
      flushPending();
      let header = line;
      if (!SCHEME_START_RE.test(header) && i > 0 && SCHEME_START_RE.test(lines[i - 1]) && !FOLIO_RE.test(lines[i - 1])) header = `${lines[i - 1]} ${header}`;
      let im = header.match(ISIN_RE) || header.match(BARE_ISIN_RE);
      if (!im && lines[i + 1]) {
        const joined = `${header} ${lines[i + 1]}`;
        im = joined.match(ISIN_RE);
        if (im) i++;
      }
      if (im) {
        scheme = { isin: im[1].toUpperCase(), name: schemeName(header), open: 0, close: null, unitSum: 0, skipped: 0, txns: [] };
        folio.schemes.push(scheme);
        continue;
      }
    }
    if (!scheme) continue;

    const om = line.match(OPEN_RE);
    if (om) { flushPending(); scheme.open = casNum(om[1]); continue; }
    const cm = line.match(CLOSE_RE);
    if (cm) { flushPending(); scheme.close = casNum(cm[1]); continue; }

    const dm = line.match(DATE_RE);
    if (dm) {
      flushPending();
      const { desc, nums } = splitNums(dm[2]);
      if (nums.length || desc.startsWith('***')) addTxn(casDate(dm[1]), desc, nums);
      else pending = { date: casDate(dm[1]), desc, nums };
      continue;
    }
    // Numbers that landed on the line below their date (wrapped description).
    if (pending) {
      const { desc, nums } = splitNums(line);
      if (nums.length >= 3) { pending.nums = nums; pending.desc += ` ${desc}`; flushPending(); }
      else if (!nums.length) pending.desc += ` ${line}`;
      else pending = null;
    }
  }
  flushPending();

  const out = [...folios.values()]
    .map((f) => ({
      ...f,
      schemes: f.schemes.map((s) => ({
        isin: s.isin,
        name: s.name,
        txns: s.txns,
        openingUnits: s.open,
        closingUnits: s.close,
        // Opening balance + every transaction should land on the closing balance.
        balanced: s.close == null || (s.skipped === 0 && Math.abs(s.open + s.unitSum - s.close) < 0.01),
      })).filter((s) => s.txns.length),
    }))
    .filter((f) => f.schemes.length);
  return { period, folios: out };
}

export async function readCas(file, password) {
  const lines = await pdfLines(new Uint8Array(await file.arrayBuffer()), password);
  const cas = parseCas(lines);
  if (!cas.folios.length) {
    throw new Error(lines.some((l) => FOLIO_RE.test(l))
      ? 'Found folios but no transactions. Request the “Detailed” statement (with transactions), not the summary.'
      : 'This doesn’t look like a CAMS / KFintech consolidated account statement.');
  }
  return cas;
}

// Same transaction already stored? Date and units identify it; the amount is left out so that
// a change in how charges are folded into amounts doesn't make old rows look new.
export const txnKey = (t) => `${t.date}|${(+t.units).toFixed(3)}`;
