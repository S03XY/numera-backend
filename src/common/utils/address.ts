import { getAddress, isAddress } from 'viem';

/** Lowercased, validated 0x address used as the canonical DB key form.
 *  Accepts any 0x+40-hex address regardless of EIP-55 casing (strict: false),
 *  then canonicalizes to lowercase. */
export function normalizeAddress(value: string): string {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`invalid address: ${value}`);
  }
  return value.toLowerCase();
}

/** EIP-55 checksummed form for display / signature verification. */
export function checksumAddress(value: string): `0x${string}` {
  return getAddress(value);
}

/** True for any well-formed 0x+40-hex address (checksum-agnostic). */
export function isValidAddress(value: string): boolean {
  return isAddress(value, { strict: false });
}
