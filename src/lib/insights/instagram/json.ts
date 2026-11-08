const MAX_DECIMAL_DIGITS = 512;

/** Preserve numeric tokens before JSON validation, without changing strings or their escapes. */
export function parseInsightJson(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > 256 * 1024) throw new Error("Insights response too large");
  let encoded = "";
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === '"') {
      const start = i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i++] === '"') { closed = true; break; }
      }
      if (!closed) throw new Error("Invalid insights JSON");
      encoded += text.slice(start, i);
    } else if (char === "-" || /[0-9]/.test(char)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
      if (!match || !/^[\s,}\]:]?$/.test(text[i + match[0].length] ?? "")) throw new Error("Invalid insights JSON");
      encoded += JSON.stringify(match[0]);
      i += match[0].length;
    } else { encoded += char; i++; }
  }
  return JSON.parse(encoded);
}

/** Canonical decimal arithmetic using digit positions, never IEEE-754 conversion. */
export function canonicalDecimal(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid insights value");
    value = String(value);
  }
  if (typeof value !== "string" || value.length > MAX_DECIMAL_DIGITS) throw new Error("Invalid insights value");
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,4}))?$/.exec(value);
  if (!match) throw new Error("Invalid insights value");
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0);
  const digits = match[1] + fraction;
  const point = match[1].length + exponent;
  if (Math.abs(exponent) > MAX_DECIMAL_DIGITS || Math.max(digits.length, point, digits.length - point) > MAX_DECIMAL_DIGITS) throw new Error("Invalid insights value");
  const integer = (point <= 0 ? "0" : digits.slice(0, point).padEnd(point, "0")).replace(/^0+(?=\d)/, "");
  const decimal = (point < 0 ? "0".repeat(-point) + digits : digits.slice(Math.max(0, point))).replace(/0+$/, "");
  return decimal ? `${integer}.${decimal}` : integer;
}
