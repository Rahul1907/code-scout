import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  add,
  subtract,
  multiply,
  divide,
  power,
  factorial,
  mean,
} from "../src/calculator.mjs";

describe("Calculator", () => {
  it("adds two numbers correctly", () => {
    assert.equal(add(2, 3), 5);
  });

  it("subtracts second number from first", () => {
    assert.equal(subtract(5, 3), 2);
    assert.equal(subtract(10, 20), -10);
  });

  it("multiplies two numbers", () => {
    assert.equal(multiply(3, 4), 12);
  });

  it("divides numbers and handles division by zero", () => {
    assert.equal(divide(10, 2), 5);
    assert.throws(() => divide(10, 0), /Division by zero/i);
  });

  it("calculates power of a number", () => {
    assert.equal(power(2, 3), 8);
    assert.equal(power(5, 0), 1);
  });

  it("computes factorial correctly", () => {
    assert.equal(factorial(0), 1);
    assert.equal(factorial(5), 120);
    assert.throws(() => factorial(-1), /Negative/i);
  });

  it("calculates mean and handles empty array safely", () => {
    assert.equal(mean([1, 2, 3, 4, 5]), 3);
    assert.equal(mean([]), 0);
  });
});

