// Budget extraction read the amount with a bare (\d+), which stops at the
// first comma. "under ₹10,000" was therefore recorded as a ₹10 budget —
// a three-orders-of-magnitude misread, stored on the conversation and fed
// back into later prompts as if the customer had said it.
//
// Indian digit grouping means this affected every budget of ₹1,000 or more,
// i.e. essentially every bulk enquiry.
//
// This imports pricing/money.js, NOT server.js. parseBudget is pure string
// work; when it lived in server.js the only way to test it was to import a
// module that calls process.exit(1) on missing env vars. That passed locally
// — a gitignored .env fed dotenv — and killed the Jest worker in CI, where
// no .env exists. Pure logic belongs outside the module with side effects.

const { parseBudget } = require('../pricing/money');

describe('parseBudget', () => {
  test('reads comma-grouped budgets correctly (previously truncated)', () => {
    expect(parseBudget('my budget is under ₹10,000')).toBe(10000);
    expect(parseBudget('looking for something below Rs. 1,50,000')).toBe(150000);
    expect(parseBudget('around ₹2,500 please')).toBe(2500);
  });

  test('still reads plain budgets', () => {
    expect(parseBudget('under 700')).toBe(700);
    expect(parseBudget('below Rs 500')).toBe(500);
    expect(parseBudget('budget ₹250')).toBe(250);
  });

  test('returns null when no budget is stated', () => {
    expect(parseBudget('do you have cork coasters?')).toBeNull();
    expect(parseBudget('')).toBeNull();
    expect(parseBudget(null)).toBeNull();
  });

  test('a trailing comma does not corrupt the value', () => {
    expect(parseBudget('under 500, maybe less')).toBe(500);
  });
});
