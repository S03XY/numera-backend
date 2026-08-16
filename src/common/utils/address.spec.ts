import { checksumAddress, isValidAddress, normalizeAddress } from './address';

const ADDR = '0x52908400098527886E0F7030069857D2E4169EE7';

describe('address utils', () => {
  it('normalizes to lowercase', () => {
    expect(normalizeAddress(ADDR)).toBe(ADDR.toLowerCase());
  });

  it('checksums to EIP-55', () => {
    expect(checksumAddress(ADDR.toLowerCase())).toBe(ADDR);
  });

  it('validates addresses', () => {
    expect(isValidAddress(ADDR)).toBe(true);
    expect(isValidAddress('0x123')).toBe(false);
    expect(isValidAddress('not-an-address')).toBe(false);
  });

  it('throws when normalizing an invalid address', () => {
    expect(() => normalizeAddress('0xdead')).toThrow(/invalid address/);
  });
});
