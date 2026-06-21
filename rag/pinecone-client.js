// Pinecone SDK singleton wrapper.
// Lazy-initializes the client only when first accessed so import is cheap.

const { Pinecone } = require('@pinecone-database/pinecone');

let client = null;
let index = null;

function isConfigured() {
  // PINECONE_INDEX is optional — falls back to 'ninecork-conversations' default.
  // Only the API key is strictly required.
  return !!process.env.PINECONE_API_KEY;
}

function getClient() {
  if (!process.env.PINECONE_API_KEY) {
    throw new Error('PINECONE_API_KEY not set');
  }
  if (!client) {
    client = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return client;
}

function getIndex() {
  if (!index) {
    const c = getClient();
    const indexName = process.env.PINECONE_INDEX || 'ninecork-conversations';
    index = c.index(indexName);
  }
  return index;
}

module.exports = { getClient, getIndex, isConfigured };
