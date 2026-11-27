/**
 * Deterministic instant answers that skip the model round-trip.
 *
 * A question like "5 km in miles" or "15% of 240" is pure arithmetic, yet paying
 * slow local inference for it costs the same as a whole agent task. For a
 * clearly-specified, self-evident query we answer directly and instantly on
 * device. The detection is deliberately conservative: only closed-form patterns
 * match, and anything ambiguous or prose-y returns `null` and falls through to
 * the model, so we never guess at something that needed reasoning.
 */
import { evaluateExpression, extractPureCalculation } from './calc-tool.mjs';

// Standard home subfolders we can list instantly. Named folders outside this
// whitelist ("this folder named archive") stay ambiguous and fall to the model.
const HOME_FOLDERS = {
  downloads: 'Downloads', desktop: 'Desktop', documents: 'Documents',
  pictures: 'Pictures', photos: 'Pictures', movies: 'Movies', music: 'Music',
  applications: 'Applications', public: 'Public',
};

// Extra qualifiers mean the request wants more than a plain top-level list —
// sorting, recursion, filtering, or a date/size window — so it needs the model.
const LIST_COMPLEXITY_RE =
  /\b(recursive\w*|subfolders?|subdirectories|sort(?:ed|ing)?|by\s+(?:size|name|date|kind)|largest|biggest|smallest|newest|oldest|recent\w*|hidden|from\s+(?:last|the)\s+(?:week|month|day|year)|older\s+than|newer\s+than|larger\s+than|smaller\s+than|filter\w*|matching|except|excluding|\w+\.(?:pdf|jpg|png|docx?|xlsx?|zip|txt))\b/i;

/**
 * Detect a simple, unambiguous request to list a standard home folder
 * ("List the files in my Downloads folder", "What's in Documents?").
 * Returns `{ name, label }` for the resolved home subfolder, or `null` to let
 * the model handle it. Read-only and conservative: a fixed folder whitelist,
 * clear listing intent, and no complexity qualifiers.
 */
export function matchNamedHomeList(message) {
  const text = String(message || '').trim();
  if (!text || text.length > 80) return null;
  if (LIST_COMPLEXITY_RE.test(text)) return null;
  const intent =
    /\b(?:list|show|what(?:'s|\s+is|\s+are)?\s+(?:in|inside|are\s+in)|contents?\s+of|files?\s+(?:in|of))\b/i;
  if (!intent.test(text)) return null;
  const folder =
    /\b(downloads?|desktop|documents?|pictures?|photos|movies|music|applications?|public)\b/i;
  const m = text.match(folder);
  if (!m) return null;
  const label = HOME_FOLDERS[m[1].toLowerCase().replace(/s$/, '')] || HOME_FOLDERS[m[1].toLowerCase()];
  return label ? { name: m[1], label } : null;
}

const NUM_RE = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const WORD_RE = '([a-z]+)';

// Factor-based units keyed by common spellings: [factor-to-base, base-dimension].
const UNITS = {
  // length (base metre)
  mm: [0.001, 'm'], cm: [0.01, 'm'], m: [1, 'm'], meter: [1, 'm'], meters: [1, 'm'], metre: [1, 'm'], metres: [1, 'm'],
  km: [1000, 'm'], kilometer: [1000, 'm'], kilometers: [1000, 'm'], kilometre: [1000, 'm'], kilometres: [1000, 'm'],
  inch: [0.0254, 'm'], inches: [0.0254, 'm'], in: [0.0254, 'm'], ft: [0.3048, 'm'], foot: [0.3048, 'm'], feet: [0.3048, 'm'],
  yd: [0.9144, 'm'], yard: [0.9144, 'm'], yards: [0.9144, 'm'], mi: [1609.344, 'm'], mile: [1609.344, 'm'], miles: [1609.344, 'm'],
  // mass (base kilogram)
  mg: [1e-6, 'kg'], g: [0.001, 'kg'], gram: [0.001, 'kg'], grams: [0.001, 'kg'],
  kg: [1, 'kg'], kilogram: [1, 'kg'], kilograms: [1, 'kg'], t: [1000, 'kg'], tonne: [1000, 'kg'], tonnes: [1000, 'kg'],
  oz: [0.028349523125, 'kg'], ounce: [0.028349523125, 'kg'], ounces: [0.028349523125, 'kg'],
  lb: [0.45359237, 'kg'], lbs: [0.45359237, 'kg'], pound: [0.45359237, 'kg'], pounds: [0.45359237, 'kg'],
  // data (base byte)
  b: [1, 'B'], byte: [1, 'B'], bytes: [1, 'B'], kb: [1e3, 'B'], kib: [1024, 'B'], mb: [1e6, 'B'], mib: [1048576, 'B'],
  gb: [1e9, 'B'], gib: [1073741824, 'B'], tb: [1e12, 'B'], tib: [1099511627776, 'B'],
  // time (base second)
  ms: [0.001, 's'], millisecond: [0.001, 's'], milliseconds: [0.001, 's'], s: [1, 's'], sec: [1, 's'], second: [1, 's'], seconds: [1, 's'],
  min: [60, 's'], mins: [60, 's'], minute: [60, 's'], minutes: [60, 's'], h: [3600, 's'], hr: [3600, 's'], hrs: [3600, 's'],
  hour: [3600, 's'], hours: [3600, 's'], day: [86400, 's'], days: [86400, 's'], week: [604800, 's'], weeks: [604800, 's'],
  // volume (base litre)
  ml: [0.001, 'L'], milliliter: [0.001, 'L'], milliliters: [0.001, 'L'], millilitre: [0.001, 'L'], millilitres: [0.001, 'L'],
  l: [1, 'L'], liter: [1, 'L'], liters: [1, 'L'], litre: [1, 'L'], litres: [1, 'L'],
  gallon: [3.785411784, 'L'], gallons: [3.785411784, 'L'], cup: [0.2365882365, 'L'], cups: [0.2365882365, 'L'],
  quart: [0.946352946, 'L'], quarts: [0.946352946, 'L'], pint: [0.473176473, 'L'], pints: [0.473176473, 'L'],
  floz: [0.0295735295625, 'L'], tbsp: [0.01478676478125, 'L'], tsp: [0.00492892159375, 'L'],
  // area (base square metre)
  acre: [4046.8564224, 'm2'], acres: [4046.8564224, 'm2'], hectare: [10000, 'm2'], hectares: [10000, 'm2'], ha: [10000, 'm2'],
  // speed (base metre per second)
  mph: [0.44704, 'mps'], kph: [0.2777777777777778, 'mps'], kmh: [0.2777777777777778, 'mps'],
  mps: [1, 'mps'], fps: [0.3048, 'mps'], knot: [0.5144444444444445, 'mps'], knots: [0.5144444444444445, 'mps'],
};

// Temperature scales convert by formula, not by a fixed factor.
const TEMP_SCALE = {
  c: 'c', celcius: 'c', celsius: 'c', centigrade: 'c',
  f: 'f', fahrenheit: 'f', farenheit: 'f',
  k: 'k', kelvin: 'k',
};

function toBaseTemp(value, scale) {
  if (scale === 'c') return { c: value };
  if (scale === 'f') return { c: (value - 32) * (5 / 9) };
  return { c: value - 273.15 };
}
function fromBaseTemp(celsius, scale) {
  if (scale === 'c') return celsius;
  if (scale === 'f') return celsius * (9 / 5) + 32;
  return celsius + 273.15;
}

function parseNum(raw) {
  return Number(String(raw).replace(/,/g, ''));
}

function convert(value, fromRaw, toRaw) {
  const from = String(fromRaw).toLowerCase();
  const to = String(toRaw).toLowerCase();
  const fs = TEMP_SCALE[from];
  const ts = TEMP_SCALE[to];
  if (fs && ts) return { value: fromBaseTemp(toBaseTemp(value, fs).c, ts), unit: to };
  if (fs || ts) return null; // mixed temperature + non-temperature
  const f = UNITS[from];
  const t = UNITS[to];
  if (!f || !t || f[1] !== t[1]) return null;
  return { value: (value * f[0]) / t[0], unit: to };
}

function fmtNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  // Cap at 5 significant digits and drop trailing zeros so conversions read
  // cleanly ("37.778 c" not "37.777778 c"). Extreme magnitudes use exponential.
  if (abs >= 1e12 || abs < 1e-9) return n.toExponential(3);
  return String(Number(n.toPrecision(5)));
}

function matchConversion(text) {
  // "5 km to miles" / "convert 100 f to c" / "5 kg in lbs"
  let m = text.match(new RegExp(`(?:convert\\s+)?${NUM_RE}\\s*${WORD_RE}\\s+(?:to|in|into|as)\\s+${WORD_RE}`, 'i'));
  if (m) {
    const converted = convert(parseNum(m[1]), m[2], m[3]);
    if (converted) return { value: parseNum(m[1]), from: m[2], converted };
  }
  // "how many miles in 5 km" / "how many hours are in 2 days"
  m = text.match(new RegExp(`how\\s+many\\s+${WORD_RE}\\s+(?:are\\s+)?in\\s+${NUM_RE}\\s*${WORD_RE}`, 'i'));
  if (m) {
    const converted = convert(parseNum(m[2]), m[3], m[1]);
    if (converted) return { value: parseNum(m[2]), from: m[3], converted };
  }
  return null;
}

function matchPercent(text) {
  const m = text.match(new RegExp(`${NUM_RE}\\s*(?:%|percent)\\s+(?:of|of\\s+what\\s+is)\\s+${NUM_RE}`, 'i'));
  if (!m) return null;
  const pct = parseNum(m[1]);
  const base = parseNum(m[2]);
  return { pct, base, value: (pct / 100) * base };
}

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const HOLIDAYS = {
  christmas: [11, 25], 'new year': [0, 1], "new year's day": [0, 1], halloween: [9, 31],
  "valentine's day": [1, 14], 'valentines day': [1, 14],
};

function dayOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function dayDiff(a, b) {
  return Math.round((dayOnly(b).getTime() - dayOnly(a).getTime()) / 86400000);
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function nextOccurrence(now, month, day) {
  let d = new Date(now.getFullYear(), month, day);
  if (dayDiff(now, d) < 0) d = new Date(now.getFullYear() + 1, month, day);
  return d;
}
function parseDateToken(raw, now) {
  const t = String(raw).trim().toLowerCase().replace(/[.!?]+$/, '');
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (HOLIDAYS[t]) {
    const [mo, day] = HOLIDAYS[t];
    return nextOccurrence(now, mo, day);
  }
  m = t.match(/^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  if (m && MONTHS[m[1]] !== undefined) {
    const mo = MONTHS[m[1]];
    const day = Number(m[2]);
    if (m[3]) return new Date(Number(m[3]), mo, day);
    return nextOccurrence(now, mo, day);
  }
  return null;
}

function matchDateMath(text) {
  const now = new Date();
  const fmt = (d) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  let m = text.match(/how\s+many\s+days\s+(until|till|to|before|since|ago)\s+(.+)/i);
  if (m) {
    const target = parseDateToken(m[2], now);
    if (target) {
      const rel = m[1].toLowerCase();
      const forward = !(rel === 'since' || rel === 'ago');
      const days = Math.abs(dayDiff(now, target));
      return { kind: 'date-math', ok: true, answer: forward ? `**${days} days** until ${fmt(target)}.` : `**${days} days** since ${fmt(target)}.` };
    }
  }
  m = text.match(/how\s+many\s+(days?|weeks?)\s+between\s+(.+?)\s+and\s+(.+)/i);
  if (m) {
    const a = parseDateToken(m[2], now);
    const b = parseDateToken(m[3], now);
    if (a && b) {
      const days = Math.abs(dayDiff(a, b));
      const weekly = /week/i.test(m[1]);
      return {
        kind: 'date-math',
        ok: true,
        answer: `**${weekly ? `${fmtNumber(days / 7)} weeks` : `${days} days`}** between ${fmt(a)} and ${fmt(b)}.`,
      };
    }
  }
  m = text.match(/(\d+)\s+(days?|weeks?)\s+(?:from\s+(?:now|today)|later|out)/i);
  if (m) {
    const n = Number(m[1]) * (/week/i.test(m[2]) ? 7 : 1);
    const target = addDays(now, n);
    return { kind: 'date-math', ok: true, answer: `${n} days from now is **${fmt(target)}**.` };
  }
  return null;
}

function matchTimeDate(text) {
  const t = text.toLowerCase().replace(/[.!?]+$/, '').trim();
  const now = new Date();
  const timeStr = `It's **${now.toLocaleTimeString()}** on ${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`;
  const dateStr = `Today is **${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}**.`;
  if (/^(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:current\s+)?time(?:\s+is\s+it)?(?:\s+(?:now|right\s+now))?$/.test(t) || t === 'time') {
    return { kind: 'time', answer: timeStr };
  }
  if (/^(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:today'?s?\s+)?(?:date|day)(?:\s+(?:is\s+it|is\s+today|today))?$/.test(t)) {
    return { kind: 'date', answer: dateStr };
  }
  return null;
}

/**
 * Answer a clearly-deterministic query instantly, or return `null` to let the
 * model handle it.
 * @param {string} message
 * @returns {{ kind: string, answer: string } | null}
 */
export function tryFastAnswer(message) {
  const text = String(message || '').trim();
  if (!text || text.length > 200) return null;

  const when = matchTimeDate(text);
  if (when) return { ...when, ok: true };

  const dateMath = matchDateMath(text);
  if (dateMath) return dateMath;

  const conversion = matchConversion(text);
  if (conversion) {
    const { value, from, converted } = conversion;
    return {
      kind: 'conversion',
      ok: true,
      answer: `${fmtNumber(value)} ${from} = **${fmtNumber(converted.value)} ${converted.unit}**`,
    };
  }

  const pct = matchPercent(text);
  if (pct) {
    return {
      kind: 'percentage',
      ok: true,
      answer: `${fmtNumber(pct.pct)}% of ${fmtNumber(pct.base)} = **${fmtNumber(pct.value)}**`,
    };
  }

  let expr = extractPureCalculation(text);
  if (!expr) {
    // Phrased arithmetic ("12 times 12", "20 plus 5") normalises to symbols so the
    // pure extractor handles wording as well as operators.
    const normalized = text
      .replace(/\bmultiplied\s+by\b/gi, '*')
      .replace(/\btimes\b/gi, '*')
      .replace(/\bdivided\s+by\b/gi, '/')
      .replace(/\bplus\b/gi, '+')
      .replace(/\bminus\b/gi, '-');
    expr = extractPureCalculation(normalized);
  }
  if (expr) {
    const computed = evaluateExpression(expr);
    if (computed.ok) {
      return { kind: 'calculation', ok: true, answer: `\`${expr}\` = **${computed.formatted}**` };
    }
    // A pure expression that failed to compute is still a deterministic answer:
    // report the error rather than routing the same broken input to the model.
    return { kind: 'calculation', ok: false, answer: `Could not compute \`${expr}\`: ${computed.error}` };
  }

  return null;
}
