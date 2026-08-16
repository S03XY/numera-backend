import { parseRegistrationPayload } from './registration-payload';

const valid = {
  address: 'unlink1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  spendingPublicKey: ['12345678901234567890', '98765432109876543210'] as [string, string],
  viewingPrivateKey: 'a'.repeat(64),
  nullifyingKey: '42',
};

describe('parseRegistrationPayload', () => {
  it('accepts a well-formed wire payload (positive)', () => {
    expect(parseRegistrationPayload(valid)).toEqual(valid);
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['an empty object', {}],
  ])('rejects %s (negative)', (_label, input) => {
    expect(() => parseRegistrationPayload(input)).toThrow();
  });

  it.each([
    'address',
    'spendingPublicKey',
    'viewingPrivateKey',
    'nullifyingKey',
  ])('rejects a payload missing %s (negative)', (field) => {
    const { [field]: _omitted, ...partial } = valid as Record<string, unknown>;
    expect(() => parseRegistrationPayload(partial)).toThrow();
  });

  it('rejects unknown extra keys rather than relaying them to the vendor (negative)', () => {
    // This body is forwarded under our admin credential; it should carry nothing unread.
    expect(() => parseRegistrationPayload({ ...valid, injected: 'value' })).toThrow();
  });

  it.each([
    ['non-numeric spending key', { spendingPublicKey: ['0xdeadbeef', '1'] }],
    ['single-element spending key', { spendingPublicKey: ['1'] }],
    ['three-element spending key', { spendingPublicKey: ['1', '2', '3'] }],
    ['0x-prefixed viewing key', { viewingPrivateKey: `0x${'a'.repeat(62)}` }],
    ['uppercase viewing key', { viewingPrivateKey: 'A'.repeat(64) }],
    ['short viewing key', { viewingPrivateKey: 'a'.repeat(62) }],
    ['long viewing key', { viewingPrivateKey: 'a'.repeat(66) }],
    ['non-numeric nullifying key', { nullifyingKey: 'abc' }],
    ['negative nullifying key', { nullifyingKey: '-1' }],
  ])('rejects %s (negative)', (_label, patch) => {
    expect(() => parseRegistrationPayload({ ...valid, ...patch })).toThrow();
  });

  it('rejects an over-long address', () => {
    expect(() => parseRegistrationPayload({ ...valid, address: 'u'.repeat(300) })).toThrow();
  });

  it('accepts boundary-length curve scalars (regression)', () => {
    // Baby Jubjub scalars are ~77 decimal digits; the bound must not clip real keys.
    const long = '9'.repeat(77);
    expect(() =>
      parseRegistrationPayload({ ...valid, spendingPublicKey: [long, long], nullifyingKey: long }),
    ).not.toThrow();
  });
});
