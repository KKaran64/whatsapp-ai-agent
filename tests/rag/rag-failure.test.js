const RagFailure = require('../../models/RagFailure');

describe('RagFailure model', () => {
  test('has failureType field', () => {
    expect(RagFailure.schema.path('failureType')).toBeDefined();
  });

  test('has customerPhone field', () => {
    expect(RagFailure.schema.path('customerPhone')).toBeDefined();
  });

  test('timestamp defaults to Date.now', () => {
    const path = RagFailure.schema.path('timestamp');
    expect(path).toBeDefined();
    expect(path.defaultValue).toBeDefined();
  });
});
