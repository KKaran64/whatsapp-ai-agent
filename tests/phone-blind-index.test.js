// Blind-index phone lookup — the mechanism that lets phone stay encrypted at
// rest while remaining queryable. Guards the exact bug this replaced: encrypted
// phone + plaintext equality query = never matches.

process.env.MONGODB_ENCRYPTION_KEY = process.env.MONGODB_ENCRYPTION_KEY || 'a'.repeat(64);

const crypto = require('crypto');
const {
  phoneBlindIndex,
  encrypt,
  isEncrypted,
  blindIndexPlugin
} = require('../mongodb-encryption');

describe('phoneBlindIndex', () => {
  test('is deterministic — same phone always yields the same hash', () => {
    expect(phoneBlindIndex('919876543210')).toBe(phoneBlindIndex('919876543210'));
  });

  test('normalizes formatting — punctuation/spacing collide to one hash', () => {
    const a = phoneBlindIndex('919876543210');
    expect(phoneBlindIndex('+91 98765 43210')).toBe(a);
    expect(phoneBlindIndex('91-98765-43210')).toBe(a);
  });

  test('different phones yield different hashes', () => {
    expect(phoneBlindIndex('919876543210')).not.toBe(phoneBlindIndex('919876543211'));
  });

  test('produces a 64-char hex digest (HMAC-SHA256), not the raw phone', () => {
    const h = phoneBlindIndex('919876543210');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('9876543210');
  });

  test('empty / missing input yields empty string (no throw)', () => {
    expect(phoneBlindIndex('')).toBe('');
    expect(phoneBlindIndex(null)).toBe('');
    expect(phoneBlindIndex(undefined)).toBe('');
  });

  test('is keyed — a different key produces a different hash (not a plain hash)', () => {
    // Plain SHA-256 of the digits would be reproducible by anyone; assert ours isn't that.
    const plainSha = crypto.createHash('sha256').update('919876543210').digest('hex');
    expect(phoneBlindIndex('919876543210')).not.toBe(plainSha);
  });
});

describe('blindIndexPlugin pre-save hook', () => {
  // Exercise the hook in isolation (no DB): register it on a bare schema-like
  // object, capture the pre-save fn, and run it against a fake document.
  function capturePreSave() {
    let fn;
    const fakeSchema = { pre: (evt, cb) => { if (evt === 'save') fn = cb; } };
    blindIndexPlugin(fakeSchema, { sourceField: 'phoneNumber', hashField: 'phoneHash' });
    return fn;
  }

  test('sets the hash from the plaintext source field on save', () => {
    const preSave = capturePreSave();
    const doc = { phoneNumber: '919876543210', isModified: () => true };
    preSave.call(doc, () => {});
    expect(doc.phoneHash).toBe(phoneBlindIndex('919876543210'));
  });

  test('does NOT hash already-encrypted input (would produce a garbage index)', () => {
    const preSave = capturePreSave();
    const doc = { phoneNumber: encrypt('919876543210'), isModified: () => true };
    expect(isEncrypted(doc.phoneNumber)).toBe(true);
    preSave.call(doc, () => {});
    expect(doc.phoneHash).toBeUndefined();
  });

  test('skips when the source field is unchanged', () => {
    const preSave = capturePreSave();
    const doc = { phoneNumber: '919876543210', isModified: () => false };
    preSave.call(doc, () => {});
    expect(doc.phoneHash).toBeUndefined();
  });
});

describe('model phoneFilter static (query wiring)', () => {
  // Loading the models builds the schema + statics without needing a DB connection.
  const Customer = require('../models/Customer');
  const Conversation = require('../models/Conversation');

  test('Customer.phoneFilter queries by phoneHash, never plaintext-only', () => {
    const f = Customer.phoneFilter('919876543210');
    expect(f.$or).toEqual([
      { phoneHash: phoneBlindIndex('919876543210') },
      { phoneNumber: '919876543210' } // migration-window fallback
    ]);
  });

  test('Conversation.phoneFilter queries by phoneHash on customerPhone', () => {
    const f = Conversation.phoneFilter('919876543210');
    expect(f.$or[0]).toEqual({ phoneHash: phoneBlindIndex('919876543210') });
    expect(f.$or[1]).toEqual({ customerPhone: '919876543210' });
  });
});
