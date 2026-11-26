/**
 * Safe arithmetic evaluator for the `calculate` tool.
 * A small recursive-descent parser over numbers, parentheses, common operators,
 * a few math functions, and constants. Never uses eval(), so it is injection-safe
 * even though the expression comes from a model.
 */

const FUNCS = {
  sqrt: (x) => Math.sqrt(x),
  abs: (x) => Math.abs(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  sin: (x) => Math.sin(x),
  cos: (x) => Math.cos(x),
  tan: (x) => Math.tan(x),
  log: (x) => Math.log(x),
  log10: (x) => Math.log10(x),
  exp: (x) => Math.exp(x),
};

const CONSTANTS = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

const MAX_INPUT = 500;
const MAX_DEPTH = 24;

class Parser {
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.depth = 0;
  }

  error(msg) {
    throw new Error(`${msg} at position ${this.pos}`);
  }

  skipSpace() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  peek() {
    this.skipSpace();
    return this.src[this.pos];
  }

  eat(str) {
    this.skipSpace();
    if (this.src.startsWith(str, this.pos)) {
      this.pos += str.length;
      return true;
    }
    return false;
  }

  parse() {
    const value = this.parseExpr();
    this.skipSpace();
    if (this.pos < this.src.length) {
      this.error(`Unexpected character "${this.src[this.pos]}"`);
    }
    return value;
  }

  parseExpr() {
    let value = this.parseTerm();
    for (;;) {
      if (this.eat('+')) value += this.parseTerm();
      else if (this.eat('-')) value -= this.parseTerm();
      else return value;
    }
  }

  parseTerm() {
    let value = this.parseFactor();
    for (;;) {
      if (this.eat('*') && !this.eat('*')) value *= this.parseFactor();
      else if (this.eat('/')) {
        const divisor = this.parseFactor();
        if (divisor === 0) this.error('Division by zero');
        value /= divisor;
      } else if (this.eat('%')) {
        const divisor = this.parseFactor();
        if (divisor === 0) this.error('Modulo by zero');
        value %= divisor;
      } else return value;
    }
  }

  parseFactor() {
    // exponent (right-associative), handle "**"
    let base = this.parseUnary();
    if (this.eat('**') || (this.src[this.pos] === '^' && this.eat('^'))) {
      base **= this.parseFactor();
    }
    return base;
  }

  parseUnary() {
    if (this.eat('+')) return this.parseUnary();
    if (this.eat('-')) return -this.parseUnary();
    return this.parsePrimary();
  }

  parsePrimary() {
    this.skipSpace();
    if (++this.depth > MAX_DEPTH) this.error('Expression too deeply nested');

    const ch = this.src[this.pos];
    if (ch === '(') {
      this.eat('(');
      const v = this.parseExpr();
      if (!this.eat(')')) this.error('Expected closing ")"');
      this.depth--;
      return v;
    }

    const wordMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(this.src.slice(this.pos));
    if (wordMatch) {
      const word = wordMatch[0].toLowerCase();
      this.pos += wordMatch[0].length;
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, word)) {
        this.depth--;
        return CONSTANTS[word];
      }
      if (Object.prototype.hasOwnProperty.call(FUNCS, word)) {
        if (!this.eat('(')) this.error(`Expected "(" after function ${word}`);
        const arg = this.parseExpr();
        if (!this.eat(')')) this.error('Expected closing ")" for function');
        this.depth--;
        return FUNCS[word](arg);
      }
      this.error(`Unknown name "${word}"`);
    }

    const numMatch = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (numMatch) {
      this.pos += numMatch[0].length;
      this.depth--;
      return Number(numMatch[0]);
    }

    this.error('Expected a number, constant, or function');
  }
}

/**
 * Detect a message that is purely a deterministic arithmetic request (e.g.
 * "calculate 25*4+7", "what is 12*12", "25*4+7") and return just the
 * expression, so the caller can compute it instantly without a model turn.
 * Deliberately conservative: anything that is not provably pure arithmetic
 * returns null and falls through to the model (e.g. "2024-01-05" is a date,
 * not a subtraction).
 */
export function extractPureCalculation(message) {
  const src = String(message || '').trim();
  if (!src) return null;
  const PREFIX = /^(?:please\s+)?(?:calculate|compute|eval(?:uate)?|solve|what(?:'s| is)|whats|how much is)\s+(.+)$/i;
  const m = PREFIX.exec(src);
  let expr;
  if (m) {
    expr = m[1];
  } else {
    // Bare expression: require a non-minus operator so date-like strings and
    // phone/id numbers do not get misread as subtraction.
    if (!/^[\d\s+\-*/().^%]+$/.test(src)) return null;
    if (!/[*/+()^%]/.test(src)) return null;
    expr = src;
  }
  expr = expr.replace(/[?=]+\s*$/, '').trim();
  if (!/^[\d\s+\-*/().^%]+$/.test(expr)) return null;
  if (!/[+\-*/^%]/.test(expr)) return null;
  return expr;
}

export function evaluateExpression(expression) {
  const src = String(expression || '');
  if (!src.trim()) {
    return { ok: false, error: 'Empty expression.' };
  }
  if (src.length > MAX_INPUT) {
    return { ok: false, error: `Expression too long (max ${MAX_INPUT} characters).` };
  }
  try {
    const value = new Parser(src).parse();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: 'Expression did not produce a finite number.' };
    }
    return { ok: true, value, formatted: formatNumber(value) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function formatNumber(value) {
  if (Number.isInteger(value)) return String(value);
  // Trim floating noise while keeping meaningful precision.
  const fixed = Number(value.toPrecision(12));
  return String(fixed);
}

export function calculateTool({ expression }) {
  const result = evaluateExpression(expression);
  if (!result.ok) {
    return { ok: false, output: `calculate error: ${result.error}` };
  }
  return {
    ok: true,
    output: `${result.formatted}`,
    value: result.value,
  };
}
