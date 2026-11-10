import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usdToMicros,
  microsToUsd,
  microsToCents,
  centsToPayPalValue,
  payPalValueToCents,
  MoneyError,
} from "../src/index.ts";

test("parses USD strings and numbers into micros", () => {
  assert.equal(usdToMicros("1"), 1_000_000);
  assert.equal(usdToMicros("$10.50"), 10_500_000);
  assert.equal(usdToMicros("0.003"), 3_000);
  assert.equal(usdToMicros("0.000001"), 1);
  assert.equal(usdToMicros(0.25), 250_000);
  assert.equal(usdToMicros(0.1 + 0.2), 300_000); // float noise is cleaned up
});

test("rejects invalid amounts", () => {
  for (const bad of ["-1", "abc", "1.0000001", "", "1e3"]) {
    assert.throws(() => usdToMicros(bad), MoneyError, bad);
  }
  assert.throws(() => usdToMicros(-2), MoneyError);
});

test("formats micros as USD", () => {
  assert.equal(microsToUsd(1_500_000), "1.50");
  assert.equal(microsToUsd(3_000), "0.003");
  assert.equal(microsToUsd(0), "0.00");
  assert.equal(microsToUsd(-250_000), "-0.25");
  assert.equal(microsToUsd(12_345_678), "12.345678");
});

test("converts between cents and PayPal values", () => {
  assert.equal(microsToCents(12_349_999), 1234);
  assert.equal(centsToPayPalValue(1000), "10.00");
  assert.equal(centsToPayPalValue(5), "0.05");
  assert.equal(payPalValueToCents("10.00"), 1000);
  assert.equal(payPalValueToCents("7.5"), 750);
});
