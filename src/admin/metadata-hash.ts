import { keccak256, toBytes } from 'viem';

/** The fields that are committed to on-chain via `metadataHash`. */
export interface CanonicalMetadata {
  title: string;
  description: string;
  /**
   * How this market will be settled: the source of truth, and what happens in the awkward cases.
   *
   * Committed to the hash rather than kept as editable copy, and that is the whole point. In an
   * optimistic system anyone may propose the result, so everybody needs to be reading the same rule
   * book — and needs to be able to prove it is the one that was published when they bet. A rule
   * that could be reworded after the fact would let the criteria be bent toward whichever answer
   * suited the operator, which is exactly the failure a bonded challenge is supposed to catch.
   *
   * Being in the hash means it cannot move: the engine stores the hash immutably at creation, so
   * anyone can re-encode what we serve, hash it, and confirm it matches the market they traded.
   */
  resolutionRules: string;
  imageUrl: string | null;
  outcomeLabels: string[];
  categoryKey: string | null;
}

/**
 * Deterministic JSON encoding of a market's metadata.
 *
 * Key order is fixed explicitly (NOT dependent on object literal order or
 * `JSON.stringify` implementation details) so the same content always produces
 * the same bytes — on any machine, in any runtime. This is what makes the
 * on-chain `metadataHash` independently verifiable: anyone can fetch the market
 * from our API, re-encode it with this scheme, hash it, and compare.
 *
 * Adding a field changes every hash it produces, so it is a breaking change for any draft that has
 * not yet been adopted by a market. Markets already created are unaffected — they carry the hash
 * they were made with, and matching only happens once, at `MarketCreated`.
 */
export function canonicalize(m: CanonicalMetadata): string {
  return JSON.stringify([
    ['title', m.title],
    ['description', m.description],
    ['resolutionRules', m.resolutionRules],
    ['imageUrl', m.imageUrl],
    ['outcomeLabels', m.outcomeLabels],
    ['categoryKey', m.categoryKey],
  ]);
}

/** keccak256 of the canonical encoding — the value passed to `createMarket`. */
export function metadataHashOf(m: CanonicalMetadata): `0x${string}` {
  return keccak256(toBytes(canonicalize(m)));
}

/**
 * Read back a canonical encoding, refusing anything that does not hash to `expectedHash`.
 *
 * ## Why the chain is parsed rather than trusted from a draft
 *
 * The engine publishes the whole metadata string in `MarketMetadataPublished`, having already
 * checked it against the `metadataHash` it stores immutably. That log is therefore the authority on
 * what a market promised, and this is how the indexer adopts it.
 *
 * Adopting from the chain rather than from our own draft table closes a real gap: a draft is a
 * local row that a migration, a restore, or a second environment can perfectly well disagree with,
 * and nothing would have noticed. A market created by somebody who never used our admin API had no
 * copy at all. Now the text and the commitment come from the same place, and there is no path by
 * which the site can display terms a market did not make.
 *
 * The hash is re-derived here anyway, rather than assumed. The contract already enforces it; doing
 * it again costs one keccak and means a mismatch shows up as a refusal here rather than as a
 * market whose displayed rules cannot be verified by the reader who checks.
 */
export function parseCanonical(
  encoded: string,
  expectedHash: string,
): CanonicalMetadata | null {
  let pairs: unknown;
  try {
    pairs = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!Array.isArray(pairs)) return null;

  const byKey = new Map<string, unknown>();
  for (const entry of pairs) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return null;
    byKey.set(entry[0], entry[1]);
  }

  const labels = byKey.get('outcomeLabels');
  const metadata: CanonicalMetadata = {
    title: str(byKey.get('title')),
    description: str(byKey.get('description')),
    resolutionRules: str(byKey.get('resolutionRules')),
    imageUrl: typeof byKey.get('imageUrl') === 'string' ? (byKey.get('imageUrl') as string) : null,
    outcomeLabels: Array.isArray(labels) ? labels.map(str) : [],
    categoryKey:
      typeof byKey.get('categoryKey') === 'string' ? (byKey.get('categoryKey') as string) : null,
  };

  // Round-trip, not a string comparison against `encoded`: this proves the parse is lossless as
  // well as that the hash matches, so what gets stored is exactly what was committed to.
  return metadataHashOf(metadata).toLowerCase() === expectedHash.toLowerCase() ? metadata : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
