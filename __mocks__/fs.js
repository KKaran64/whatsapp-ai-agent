// Manual mock for Node.js 'fs' core module
// Jest uses this automatically when jest.mock('fs') is called
const actualFs = jest.requireActual('fs');

const mockPromises = {
  readFile: jest.fn(() => Promise.reject(new Error('ENOENT'))),
  writeFile: jest.fn(() => Promise.resolve()),
  stat: jest.fn(() => Promise.reject(new Error('ENOENT'))),
  access: jest.fn(() => Promise.reject(new Error('ENOENT')))
};

module.exports = {
  ...actualFs,
  // Override existsSync for vision-handler stats file loading
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  promises: mockPromises
};
