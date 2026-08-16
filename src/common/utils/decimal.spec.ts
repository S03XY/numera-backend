import { Prisma } from '@prisma/client';
import { toHuman, toStr, wadToProbability } from './decimal';

describe('decimal utils', () => {
  it('toStr serializes Decimal, bigint, number, and null', () => {
    expect(toStr(new Prisma.Decimal('12345'))).toBe('12345');
    expect(toStr(42n)).toBe('42');
    expect(toStr(7)).toBe('7');
    expect(toStr(null)).toBeNull();
    expect(toStr(undefined)).toBeNull();
  });

  it('toHuman formats base units by decimals', () => {
    expect(toHuman(1_500_000n, 6)).toBe('1.5');
    expect(toHuman(new Prisma.Decimal('1000000'), 6)).toBe('1');
    expect(toHuman(null, 6)).toBeNull();
  });

  it('wadToProbability converts WAD to [0,1]', () => {
    expect(wadToProbability(500000000000000000n)).toBe('0.5');
    expect(wadToProbability(10n ** 18n)).toBe('1');
  });
});
