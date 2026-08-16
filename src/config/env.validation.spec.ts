import { validateEnv } from './env.validation';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(16),
  JWT_REFRESH_SECRET: 'b'.repeat(16),
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv({ ...base });
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.INDEXER_ENABLED).toBe(false);
    expect(env.CORS_ORIGINS).toContain('http://localhost:5173');
  });

  it('coerces numeric strings and splits CSV', () => {
    const env = validateEnv({ ...base, PORT: '4000', CORS_ORIGINS: 'a.com, b.com' });
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['a.com', 'b.com']);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL, ...noDb } = base;
    expect(() => validateEnv(noDb)).toThrow(/DATABASE_URL/);
  });

  it('rejects a too-short JWT secret', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects indexer enabled without an RPC url (cross-field guard)', () => {
    expect(() => validateEnv({ ...base, INDEXER_ENABLED: 'true' })).toThrow(/RPC_HTTP_URL/);
  });

  it('accepts indexer enabled when an RPC url is provided', () => {
    const env = validateEnv({
      ...base,
      INDEXER_ENABLED: 'true',
      RPC_HTTP_URL: 'https://rpc.example.com',
    });
    expect(env.INDEXER_ENABLED).toBe(true);
  });

  it('rejects an invalid contract address', () => {
    expect(() => validateEnv({ ...base, LS_LMSR_MARKET_ADDRESS: '0xnothex' })).toThrow();
  });
});

describe('validateEnv — Unlink', () => {
  const creds = { UNLINK_API_KEY: 'sk_test_key', UNLINK_APP_ID: 'numera' };

  it('defaults to disabled so the stack boots with no vendor credentials (positive)', () => {
    const env = validateEnv({ ...base });
    expect(env.UNLINK_ENABLED).toBe(false);
    expect(env.UNLINK_ENVIRONMENT).toBe('monad-testnet');
  });

  it('accepts a fully-credentialed enable (positive)', () => {
    const env = validateEnv({ ...base, UNLINK_ENABLED: 'true', ...creds });
    expect(env.UNLINK_ENABLED).toBe(true);
    expect(env.UNLINK_API_KEY).toBe('sk_test_key');
    expect(env.UNLINK_TOKEN_TTL_SECONDS).toBe(900);
  });

  it.each([
    ['UNLINK_API_KEY', { UNLINK_APP_ID: 'numera' }],
    ['UNLINK_APP_ID', { UNLINK_API_KEY: 'sk_test_key' }],
  ])('refuses to enable Unlink without %s (negative)', (missing, partial) => {
    expect(() => validateEnv({ ...base, UNLINK_ENABLED: 'true', ...partial })).toThrow(
      new RegExp(missing),
    );
  });

  it('names every missing credential at once rather than one per boot (negative)', () => {
    expect(() => validateEnv({ ...base, UNLINK_ENABLED: 'true' })).toThrow(
      /UNLINK_API_KEY and UNLINK_APP_ID/,
    );
  });

  it('rejects setting both an environment name and an engine URL (negative)', () => {
    // The SDK throws on this combination; catching it at boot gives a readable error.
    expect(() =>
      validateEnv({
        ...base,
        UNLINK_ENVIRONMENT: 'base-sepolia',
        UNLINK_ENGINE_URL: 'https://custom.example.com',
      }),
    ).toThrow(/not both/);
  });

  it('allows an engine URL override while the environment sits at its default', () => {
    const env = validateEnv({ ...base, UNLINK_ENGINE_URL: 'https://custom.example.com' });
    expect(env.UNLINK_ENGINE_URL).toBe('https://custom.example.com');
  });

  it('bounds the authorization-token TTL to the backend maximum (negative)', () => {
    expect(() => validateEnv({ ...base, UNLINK_TOKEN_TTL_SECONDS: '901' })).toThrow();
    expect(() => validateEnv({ ...base, UNLINK_TOKEN_TTL_SECONDS: '0' })).toThrow();
  });

  it('leaves every pre-existing guard intact (regression)', () => {
    // Unlink config must not have loosened the indexer or production-admin guards.
    expect(() => validateEnv({ ...base, INDEXER_ENABLED: 'true' })).toThrow(/RPC_HTTP_URL/);
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', ADMIN_DEV_ADDRESSES: '0xabc' }),
    ).toThrow(/ADMIN_DEV_ADDRESSES/);
  });
});
