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
  const rounded = Math.abs(n) >= 100 ? Math.round(n * 100) / 100 : Math.round(n * 1e6) / 1e6;
  return String(rounded);
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
