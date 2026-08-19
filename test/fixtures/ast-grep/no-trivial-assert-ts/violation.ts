declare const describe: any;
declare const it: any;
declare const expect: any;

describe('placeholder tests', () => {
  // Violation 1: the classic always-green placeholder
  it('does something', () => {
    expect(true).toBe(true);
  });

  // Violation 2: same with false
  it('does something else', () => {
    expect(false).toBe(false);
  });

  // Violation 3: numeric tautology
  it('adds up', () => {
    expect(1).toBe(1);
  });
});
