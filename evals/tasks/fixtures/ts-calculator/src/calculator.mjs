/**
 * CodeScout Fixture: ts-calculator
 * Math and statistical functions.
 */

export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  // BUG: Adds instead of subtracting
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}

export function divide(a, b) {
  // BUG: Does not check for division by zero
  return a / b;
}

export function power(base, exponent) {
  // TODO: Not yet implemented
  throw new Error("Not implemented");
}

export function factorial(n) {
  // TODO: Not yet implemented
  throw new Error("Not implemented");
}

export function mean(numbers) {
  // BUG: Returns NaN for empty array
  return numbers.reduce((acc, curr) => acc + curr, 0) / numbers.length;
}
