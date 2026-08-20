import { describe, it, expect } from 'vitest';
import { add, subtract, isEven, isAdult, inRange } from '../src/calc';

// These tests deliberately DO NOT fully pin down every function. In particular
// `inRange` is only tested with an in-range value, so mutations to its bounds /
// logical operator survive. This proves the mutation score computation is real
// (a genuine < 100% result), not a trivially perfect run.

describe('add', () => {
  it('adds two numbers', () => {
    expect(add(2, 3)).toBe(5);
    expect(add(-1, 1)).toBe(0);
  });
});

describe('subtract', () => {
  it('subtracts two numbers', () => {
    expect(subtract(5, 3)).toBe(2);
    expect(subtract(0, 4)).toBe(-4);
  });
});

describe('isEven', () => {
  it('detects even and odd', () => {
    expect(isEven(4)).toBe(true);
    expect(isEven(3)).toBe(false);
  });
});

describe('isAdult', () => {
  it('is true at and above 18', () => {
    expect(isAdult(18)).toBe(true);
    expect(isAdult(21)).toBe(true);
  });
  it('is false below 18', () => {
    expect(isAdult(17)).toBe(false);
  });
});

describe('inRange', () => {
  // Intentional coverage gap: only a value comfortably inside the range is
  // asserted, so boundary/logical mutants of inRange are NOT killed.
  it('is true for a value inside the range', () => {
    expect(inRange(5, 0, 10)).toBe(true);
  });
});
