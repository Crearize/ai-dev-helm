declare const describe: any;
declare const it: any;
declare const test: any;
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
