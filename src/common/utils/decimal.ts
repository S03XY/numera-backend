import { Prisma } from '@prisma/client';
import { formatUnits } from 'viem';

/**
 * Plain (non-exponential) integer string for any on-chain value. Prisma's
 * Decimal.toString() switches to exponential notation for large magnitudes
 * (e.g. 78-digit uint256 sentinels, `b` up to 1e30), which would corrupt API
 * output and break BigInt() parsing — so Decimals go through toFixed(0). All our
 * on-chain values are integers (Decimal(78,0)), so no rounding occurs.
 */
function rawInt(v: Prisma.Decimal | bigint | number): string {
  return v instanceof Prisma.Decimal ? v.toFixed(0) : v.toString();
}

/** Serialize an on-chain integer (Prisma Decimal / bigint) to a base-unit string. */
export function toStr(v: Prisma.Decimal | bigint | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return rawInt(v);
}

/** Human-readable amount, e.g. 1500000 base units @ 6 decimals -> "1.5". */
export function toHuman(
  v: Prisma.Decimal | bigint | number | null | undefined,
  decimals: number,
): string | null {
  if (v === null || v === undefined) return null;
  try {
    return formatUnits(BigInt(rawInt(v)), decimals);
  } catch {
    return null;
  }
}

/** WAD (1e18) fixed-point price -> decimal probability string in [0,1]. */
export function wadToProbability(v: Prisma.Decimal | bigint | number | null | undefined): string | null {
  return toHuman(v, 18);
}
