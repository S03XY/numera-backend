import { canonicalize, metadataHashOf, parseCanonical, type CanonicalMetadata } from './metadata-hash';

/**
 * The commitment, from both ends.
 *
 * A market's metadata hash is only worth something if a reader can re-encode what the API serves,
 * hash it, and get the value the chain stores. That means the encoding has to be deterministic and
 * the decoding has to be lossless — and, crucially, has to *refuse* anything that does not round
 * trip. A parser that accepted approximately-right metadata would let the site display resolution
 * criteria nobody actually committed to, which is the exact failure the hash exists to prevent.
 */

const METADATA: CanonicalMetadata = {
  title: 'Will it rain in Bengaluru tomorrow?',
  description: 'Settles on the IMD observation for the city station.',
  resolutionRules: 'YES if recorded rainfall exceeds 0.1mm between 00:00 and 23:59 IST.',
  imageUrl: 'https://example.test/rain.png',
  outcomeLabels: ['Yes', 'No'],
  categoryKey: 'WEATHER',
};

describe('market metadata commitment', () => {
  it('round trips through the encoding the chain publishes', () => {
    const encoded = canonicalize(METADATA);

    expect(parseCanonical(encoded, metadataHashOf(METADATA))).toEqual(METADATA);
  });

  it('survives the nulls, which are the fields most likely to be dropped', () => {
    const sparse: CanonicalMetadata = {
      ...METADATA,
      description: '',
      imageUrl: null,
      categoryKey: null,
    };

    expect(parseCanonical(canonicalize(sparse), metadataHashOf(sparse))).toEqual(sparse);
  });

  it('refuses metadata that does not hash to the market’s commitment', () => {
    const tampered = { ...METADATA, resolutionRules: 'YES if it feels rainy.' };

    // The rewritten rules hash to something else, so they are dropped rather than displayed.
    expect(parseCanonical(canonicalize(tampered), metadataHashOf(METADATA))).toBeNull();
  });

  it('refuses a title changed after the fact', () => {
    const tampered = { ...METADATA, title: 'Will it rain in Chennai tomorrow?' };

    expect(parseCanonical(canonicalize(tampered), metadataHashOf(METADATA))).toBeNull();
  });

  it('refuses outcome labels that were swapped', () => {
    const swapped = { ...METADATA, outcomeLabels: ['No', 'Yes'] };

    expect(parseCanonical(canonicalize(swapped), metadataHashOf(METADATA))).toBeNull();
  });

  it('refuses anything that is not the canonical encoding at all', () => {
    const hash = metadataHashOf(METADATA);

    expect(parseCanonical('not json', hash)).toBeNull();
    expect(parseCanonical('{"title":"x"}', hash)).toBeNull();
    expect(parseCanonical('[["title"]]', hash)).toBeNull();
    expect(parseCanonical('', hash)).toBeNull();
  });

  it('encodes deterministically, whatever order the fields are written in', () => {
    const reordered: CanonicalMetadata = {
      categoryKey: METADATA.categoryKey,
      outcomeLabels: METADATA.outcomeLabels,
      imageUrl: METADATA.imageUrl,
      resolutionRules: METADATA.resolutionRules,
      description: METADATA.description,
      title: METADATA.title,
    };

    // Key order in the literal must not reach the bytes, or the same content would commit to
    // different hashes on different machines.
    expect(metadataHashOf(reordered)).toBe(metadataHashOf(METADATA));
  });
});
