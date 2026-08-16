import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.validation';

/**
 * Strongly-typed, domain-grouped accessor over the validated environment.
 * Inject this instead of ConfigService so call-sites get real types and
 * autocomplete (e.g. `cfg.chain.lsLmsrAddress`) rather than stringly-typed lookups.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get isTest(): boolean {
    return this.get('NODE_ENV') === 'test';
  }

  get app() {
    return {
      nodeEnv: this.get('NODE_ENV'),
      port: this.get('PORT'),
      corsOrigins: this.get('CORS_ORIGINS'),
      url: this.get('APP_URL'),
      logLevel: this.get('LOG_LEVEL'),
    };
  }

  get database() {
    return { url: this.get('DATABASE_URL') };
  }

  get redis() {
    return {
      host: this.get('REDIS_HOST'),
      port: this.get('REDIS_PORT'),
      password: this.get('REDIS_PASSWORD') || undefined,
      db: this.get('REDIS_DB'),
    };
  }

  get auth() {
    return {
      chainId: this.get('AUTH_CHAIN_ID'),
      siweStatement: this.get('AUTH_SIWE_STATEMENT'),
      accessSecret: this.get('JWT_ACCESS_SECRET'),
      refreshSecret: this.get('JWT_REFRESH_SECRET'),
      accessTtl: this.get('JWT_ACCESS_TTL'),
      refreshTtl: this.get('JWT_REFRESH_TTL'),
      nonceTtlSeconds: this.get('AUTH_NONCE_TTL_SECONDS'),
    };
  }

  get chain() {
    return {
      chainId: this.get('CHAIN_ID'),
      httpUrl: this.get('RPC_HTTP_URL'),
      wsUrl: this.get('RPC_WS_URL'),
      indexerEnabled: this.get('INDEXER_ENABLED'),
      startBlock: BigInt(this.get('INDEXER_START_BLOCK')),
      batchBlocks: BigInt(this.get('INDEXER_BATCH_BLOCKS')),
      confirmations: BigInt(this.get('INDEXER_CONFIRMATIONS')),
      pollIntervalMs: this.get('INDEXER_POLL_INTERVAL_MS'),
      collateralDecimals: this.get('COLLATERAL_DECIMALS'),
      addresses: {
        lsLmsr: this.normalizeAddr(this.get('LS_LMSR_MARKET_ADDRESS')),
        factory: this.normalizeAddr(this.get('MARKET_FACTORY_ADDRESS')),
        trustedResolver: this.normalizeAddr(this.get('TRUSTED_RESOLVER_ADDRESS')),
        optimisticResolver: this.normalizeAddr(this.get('OPTIMISTIC_RESOLVER_ADDRESS')),
        resolverMultisig: this.normalizeAddr(this.get('RESOLVER_MULTISIG_ADDRESS')),
        blocklist: this.normalizeAddr(this.get('TRADING_BLOCKLIST_ADDRESS')),
        usdc: this.normalizeAddr(this.get('USDC_ADDRESS')),
      },
    };
  }

  get unlink() {
    const engineUrl = this.get('UNLINK_ENGINE_URL');
    return {
      enabled: this.get('UNLINK_ENABLED'),
      /**
       * Exactly one of these reaches the SDK — it throws if given both. A custom
       * `UNLINK_ENGINE_URL` wins and suppresses the environment name.
       */
      environment: engineUrl ? undefined : this.get('UNLINK_ENVIRONMENT'),
      engineUrl: engineUrl || undefined,
      apiKey: this.get('UNLINK_API_KEY'),
      appId: this.get('UNLINK_APP_ID'),
      tokenTtlSeconds: this.get('UNLINK_TOKEN_TTL_SECONDS'),
    };
  }

  /**
   * Gas relay settings.
   *
   * Every limit here bounds *cost*, never identity: the relay accepts a signature and nothing
   * else, because any identifier it accepted would let our logs record which user owns which
   * market account. See `relay/relay.service.ts` for why that trade is worth making, and what
   * takes authentication's place.
   */
  get relay() {
    const key = this.get('RELAYER_PRIVATE_KEY');
    return {
      enabled: this.get('RELAY_ENABLED'),
      forwarder: this.normalizeAddr(this.get('NUMERA_FORWARDER_ADDRESS')),
      resolutionForwarder: this.normalizeAddr(this.get('RESOLUTION_FORWARDER_ADDRESS')),
      privateKey: key ? ((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`) : undefined,
      maxGas: BigInt(this.get('RELAY_MAX_GAS')),
      maxFeePerGas: BigInt(Math.round(this.get('RELAY_MAX_FEE_GWEI') * 1e9)),
      accountLimit: this.get('RELAY_ACCOUNT_LIMIT'),
      accountWindowSeconds: this.get('RELAY_ACCOUNT_WINDOW_SECONDS'),
      dailyCapWei: BigInt(Math.round(this.get('RELAY_DAILY_CAP_MON') * 1e9)) * 1_000_000_000n,
      minBalanceWei: BigInt(Math.round(this.get('RELAY_MIN_BALANCE_MON') * 1e9)) * 1_000_000_000n,
      permit2: this.normalizeAddr(this.get('PERMIT2_ADDRESS')),
    };
  }

  /**
   * Numera's shielded pool.
   *
   * `enabled` is derived rather than configured: a pool with no addresses is not a pool, and a
   * separate flag would only create a state where it claims to be on and cannot answer. The
   * endpoints check this one property.
   */
  get pool() {
    const entrypoint = this.normalizeAddr(this.get('POOL_ENTRYPOINT_ADDRESS'));
    const privacyPool = this.normalizeAddr(this.get('PRIVACY_POOL_ADDRESS'));
    const startBlock = this.get('POOL_START_BLOCK');
    return {
      enabled: Boolean(entrypoint && privacyPool),
      entrypoint,
      privacyPool,
      startBlock: startBlock === undefined ? this.chain.startBlock : BigInt(startBlock),
    };
  }

  /**
   * Automatic settlement of proposals nobody challenged.
   *
   * Rides on the relay's key and its spend limits rather than adding its own, because it is the
   * same wallet sending the same kind of transaction. See `relay/settlement.service.ts`.
   */
  get settlement() {
    return {
      enabled: this.get('SETTLEMENT_ENABLED'),
      pollIntervalMs: this.get('SETTLEMENT_POLL_INTERVAL_MS'),
    };
  }

  get admin() {
    return {
      /** Dev-only allowlist used when no chain is configured; empty in production. */
      devAddresses: this.get('ADMIN_DEV_ADDRESSES').map((a) => a.toLowerCase()),
    };
  }

  get throttle() {
    return {
      ttlSeconds: this.get('THROTTLE_TTL_SECONDS'),
      limit: this.get('THROTTLE_LIMIT'),
    };
  }

  private normalizeAddr(value: string): `0x${string}` | null {
    if (!value || /^0x0{40}$/i.test(value)) return null;
    return value.toLowerCase() as `0x${string}`;
  }
}
