import { z } from 'zod';

/**
 * Full environment schema. Parsed once at boot; any missing/invalid required
 * variable throws before the app starts listening (fail-fast).
 */
const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const address = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 20-byte 0x address');

export const envSchema = z.object({
  // App
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGINS: csv.default('http://localhost:5173'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // Database
  DATABASE_URL: z.string().min(1),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_DB: z.coerce.number().int().min(0).default(0),

  // Auth
  AUTH_CHAIN_ID: z.coerce.number().int().positive().default(10143),
  AUTH_SIWE_STATEMENT: z.string().default('Sign in to Synthatic Prediction Market.'),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('900s'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  AUTH_NONCE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Chain / indexer
  CHAIN_ID: z.coerce.number().int().positive().default(10143),
  RPC_HTTP_URL: z.string().url().optional().or(z.literal('')).default(''),
  RPC_WS_URL: z.string().url().optional().or(z.literal('')).default(''),
  INDEXER_ENABLED: boolish.default('false'),
  INDEXER_START_BLOCK: z.coerce.number().int().min(0).default(0),
  INDEXER_BATCH_BLOCKS: z.coerce.number().int().positive().default(2000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(2),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),

  // Contract addresses (optional — indexer only needs the ones that are set)
  LS_LMSR_MARKET_ADDRESS: address.optional().or(z.literal('')).default(''),
  MARKET_FACTORY_ADDRESS: address.optional().or(z.literal('')).default(''),
  /** The resolver every market is bound to. Immutable per market, so this rarely changes. */
  TRUSTED_RESOLVER_ADDRESS: address.optional().or(z.literal('')).default(''),
  /** The bonded proposal layer, and the only holder of RESOLVER_ROLE on the trusted resolver. */
  OPTIMISTIC_RESOLVER_ADDRESS: address.optional().or(z.literal('')).default(''),
  /** The quorum that rules on disputes. */
  RESOLVER_MULTISIG_ADDRESS: address.optional().or(z.literal('')).default(''),
  /** The shared ban list every engine reads. */
  TRADING_BLOCKLIST_ADDRESS: address.optional().or(z.literal('')).default(''),
  USDC_ADDRESS: address.optional().or(z.literal('')).default(''),
  COLLATERAL_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),

  // Unlink (privacy layer). Disabled by default so the stack boots without vendor
  // credentials; turning it on requires the full credential set (guarded below).
  UNLINK_ENABLED: boolish.default('false'),
  UNLINK_ENVIRONMENT: z.string().min(1).default('monad-testnet'),
  UNLINK_ENGINE_URL: z.string().url().optional().or(z.literal('')).default(''),
  UNLINK_API_KEY: z.string().optional().default(''),
  UNLINK_APP_ID: z.string().optional().default(''),
  UNLINK_TOKEN_TTL_SECONDS: z.coerce.number().int().min(1).max(900).default(900),

  // Gas relay. Off by default so the stack boots without a funded hot key; turning it on
  // requires the forwarder address and the key together (guarded below).
  //
  // The relay is deliberately UNAUTHENTICATED: it accepts a signature and nothing else. Any
  // identifier it accepted would let these logs record which user owns which market account,
  // rebuilding exactly the link the privacy design exists to break. Every limit below therefore
  // bounds cost rather than identity — see `relay/relay.service.ts`.
  RELAY_ENABLED: boolish.default('false'),
  NUMERA_FORWARDER_ADDRESS: address.optional().or(z.literal('')).default(''),
  /**
   * The second forwarder, for proposing and disputing outcomes.
   *
   * Optional even when the relay is on: trading and resolution are separate products, and a
   * deployment can reasonably sponsor one and not the other. When unset the resolution relay
   * endpoints refuse, rather than the whole service failing to boot.
   */
  RESOLUTION_FORWARDER_ADDRESS: address.optional().or(z.literal('')).default(''),
  /** Hot key. Keep a small float and top it up; a leak costs a day of gas, not the treasury. */
  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, 'RELAYER_PRIVATE_KEY must be a 32-byte hex key')
    .optional()
    .or(z.literal(''))
    .default(''),
  /**
   * Ceiling on the gas limit we will declare. Monad bills the limit, so this is a spend cap.
   *
   * Raised from a 2,000,000 ceiling when the shielded pool arrived: a withdrawal verifies a Groth16
   * proof, inserts a tree leaf and moves collateral twice, which estimates around 1.6M. The old
   * ceiling left no room for it at all, and the failure surfaced as "the contract rejected this
   * call" — which is exactly what it was not.
   *
   * This bounds what one call may declare, not what the day may cost; `RELAY_DAILY_CAP_MON` does
   * that, and it is the one that fails closed.
   */
  RELAY_MAX_GAS: z.coerce.number().int().positive().max(3_000_000).default(700_000),
  /** Ceiling on the fee we will pay per unit of gas, in gwei. Caps the other half of the spend. */
  RELAY_MAX_FEE_GWEI: z.coerce.number().positive().default(200),
  /** Requests per market account per window. Anti-accident; the real bound is the trade minimum. */
  RELAY_ACCOUNT_LIMIT: z.coerce.number().int().positive().default(20),
  RELAY_ACCOUNT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** Hard daily ceiling on relayed gas spend, in whole MON. Fails closed when reached. */
  RELAY_DAILY_CAP_MON: z.coerce.number().positive().default(50),
  /** Warn when the relayer's balance falls below this, in whole MON. */
  RELAY_MIN_BALANCE_MON: z.coerce.number().positive().default(2),
  /**
   * Permit2, the only spender besides the engine that a relayed approval may name.
   *
   * A market account holds no gas, so it cannot send `approve` — and the shielded pool's deposit
   * path needs a Permit2 allowance. It gets one by signature instead, submitted here. Restricting
   * the spender to two immutable contracts is what keeps that from becoming "we pay for anyone's
   * approvals": an allowance to our engine or to Permit2, granted by an account with no funds,
   * is worth nothing to an attacker.
   */
  PERMIT2_ADDRESS: address.optional().or(z.literal('')).default('0x000000000022D473030F116dDEE9F6B43aC78BA3'),

  /**
   * Numera's own shielded pool.
   *
   * Two addresses because they do different jobs and are read by different code. `PrivacyPool` is
   * where the leaves live and the only address the pool indexer watches; `NumeraPoolEntrypoint` is
   * the only address anything is ever sent to. Both empty means the privacy layer is simply absent
   * and every pool endpoint says so, rather than the process refusing to boot — a deployment
   * running the market engine alone is a legitimate configuration.
   */
  POOL_ENTRYPOINT_ADDRESS: address.optional().or(z.literal('')).default(''),
  PRIVACY_POOL_ADDRESS: address.optional().or(z.literal('')).default(''),
  /**
   * Where the pool indexer starts.
   *
   * Separate from `INDEXER_START_BLOCK` because the pool is deployed independently of the engine
   * and a shared start block means either re-scanning thousands of empty blocks or, far worse,
   * starting *after* the first deposit — which produces a state tree that is missing a leaf and
   * therefore a root that matches nothing, for everybody, permanently. Defaults to the engine's
   * start block when unset.
   */
  POOL_START_BLOCK: z.coerce.number().int().nonnegative().optional(),

  /**
   * Settle unchallenged proposals automatically.
   *
   * A proposal whose challenge window has passed is not settled: the chain still needs somebody to
   * send `finalize`, and until they do the engine reports the market as trading and every winner's
   * claim reverts. Leaving that to "somebody" meant leaving it to nobody, and the market that
   * exposed it sat unclaimable with a winner watching it.
   *
   * `finalize` is permissionless and pays the reward to the recorded proposer whoever sends it, so
   * a keeper cannot take anything by sending it and reveals nothing by being the sender.
   */
  SETTLEMENT_ENABLED: boolish.default('true'),
  /** How often to look for proposals whose window has passed. */
  SETTLEMENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(20_000),

  // Admin (authorization is on-chain; this is a local-dev fallback only)
  ADMIN_DEV_ADDRESSES: csv.default(''),

  // Rate limiting
  THROTTLE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  // Cross-field guard: indexer on ⇒ an HTTP RPC is mandatory.
  if (parsed.data.INDEXER_ENABLED && !parsed.data.RPC_HTTP_URL) {
    throw new Error(
      'INDEXER_ENABLED=true requires RPC_HTTP_URL to be set to a Monad RPC endpoint.',
    );
  }
  // Unlink on ⇒ the full credential set is mandatory. A half-configured privacy
  // layer is the dangerous state: the UI would offer private trading and then
  // fail at the first call, after the user has already committed funds.
  if (parsed.data.UNLINK_ENABLED) {
    const missing = (
      [
        ['UNLINK_API_KEY', parsed.data.UNLINK_API_KEY],
        ['UNLINK_APP_ID', parsed.data.UNLINK_APP_ID],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`UNLINK_ENABLED=true requires ${missing.join(' and ')} to be set.`);
    }
  }
  // The SDK rejects being given both an environment name and an engine URL. Catch
  // it at boot with a readable message instead of at the first Unlink call.
  if (parsed.data.UNLINK_ENGINE_URL && parsed.data.UNLINK_ENVIRONMENT !== 'monad-testnet') {
    throw new Error(
      'Set either UNLINK_ENVIRONMENT or UNLINK_ENGINE_URL, not both. ' +
        'UNLINK_ENGINE_URL is the escape hatch for custom deployments.',
    );
  }
  // Relay on ⇒ the full set is mandatory, for the same reason as Unlink: a half-configured relay
  // means the UI offers gasless trading and then fails after the user has committed funds to a
  // market account. It also needs an RPC — every defence it has (simulate, verify, submit) is a
  // chain call, and a relay that cannot reach the chain cannot check anything.
  if (parsed.data.RELAY_ENABLED) {
    const missing = (
      [
        ['NUMERA_FORWARDER_ADDRESS', parsed.data.NUMERA_FORWARDER_ADDRESS],
        ['RELAYER_PRIVATE_KEY', parsed.data.RELAYER_PRIVATE_KEY],
        ['RPC_HTTP_URL', parsed.data.RPC_HTTP_URL],
        ['LS_LMSR_MARKET_ADDRESS', parsed.data.LS_LMSR_MARKET_ADDRESS],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`RELAY_ENABLED=true requires ${missing.join(', ')} to be set.`);
    }
  }
  // Safety guard: the admin dev allowlist bypasses on-chain role checks, so it
  // must never be present in production. Fail the boot rather than run insecure.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.ADMIN_DEV_ADDRESSES.length > 0) {
    throw new Error(
      'ADMIN_DEV_ADDRESSES must be empty in production — admin authorization must come from on-chain roles.',
    );
  }
  return parsed.data;
}
