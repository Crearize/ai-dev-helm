declare const describe: any;
declare const it: any;
declare const test: any;
declare const fit: any;
declare const fdescribe: any;
declare const expect: any;

// Violation 1: focused describe block
describe.only('checkout flow', () => {
  it('charges the card', () => {
    expect(1).toBe(1);
  });
});

// Violation 2: focused it block
describe('cart', () => {
  it.only('adds an item', () => {
    expect(1).toBe(1);
  });
});

// Violation 3: focused test block
test.only('renders the header', () => {
  expect(1).toBe(1);
});

// Violation 4: Jasmine/Jest focused alias fit
fit('runs one spec', () => {
  expect(1).toBe(1);
});

// Violation 5: Jasmine/Jest focused alias fdescribe
fdescribe('one suite', () => {
  it('runs', () => {
    expect(1).toBe(1);
  });
});

// Violation 6: parameterised focus with .only.each
it.only.each([1, 2])('handles %i', (n: number) => {
  expect(n).toBeGreaterThan(0);
});
