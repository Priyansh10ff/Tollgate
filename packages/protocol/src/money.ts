/**
 * Money is stored as integer "micros": 1 USD = 1,000,000 micros.
 *
 * Integers avoid floating-point rounding errors, and micros are small enough
 * to price a single API call at fractions of a cent (e.g. $0.0005).
 * PayPal itself only moves whole cents, so conversions to cents always round
 * down and the remainder stays in the ledger.
 */

export const MICROS_PER_USD = 1_000_000;
export const MICROS_PER_CENT = 10_000;

const USD_PATTERN = /^\$?(\d{1,9})(?:\.(\d{1,6}))?$/;

export class MoneyError extends Error {}

/** Parses "$1.25", "0.003" or 2 into micros. Rejects negatives and more than 6 decimals. */
export function usdToMicros(input: string | number): number {
  const text = typeof input === "number" ? numberToPlainString(input) : input.trim();
  const match = USD_PATTERN.exec(text);
  if (!match) throw new MoneyError(`Invalid USD amount: "${input}"`);
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(6, "0"));
  return whole * MICROS_PER_USD + fraction;
}

/** Formats micros as USD: 1_500_000 → "1.50", 3_000 → "0.003". Always at least 2 decimals. */
export function microsToUsd(micros: number): string {
  assertMicros(micros);
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / MICROS_PER_USD);
  let fraction = String(abs % MICROS_PER_USD).padStart(6, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${sign}${whole}.${fraction}`;
}

/** Whole cents contained in an amount (rounded down). */
export function microsToCents(micros: number): number {
  assertMicros(micros);
  return Math.floor(micros / MICROS_PER_CENT);
}

export function centsToMicros(cents: number): number {
  if (!Number.isSafeInteger(cents)) throw new MoneyError(`Cents must be an integer: ${cents}`);
  return cents * MICROS_PER_CENT;
}

/** PayPal amount string from cents: 1000 → "10.00". */
export function centsToPayPalValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new MoneyError(`Invalid cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Parses a PayPal amount string ("10.00") into cents. */
export function payPalValueToCents(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new MoneyError(`Invalid PayPal amount: "${value}"`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function assertMicros(micros: number): void {
  if (!Number.isSafeInteger(micros)) throw new MoneyError(`Amount must be an integer number of micros: ${micros}`);
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new MoneyError(`Invalid USD amount: ${n}`);
  // toFixed(6) avoids exponent notation for small numbers like 1e-7.
  return n.toFixed(6).replace(/\.?0+$/, "");
}
