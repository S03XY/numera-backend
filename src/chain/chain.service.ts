import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  Abi,
  AbiEvent,
  Chain,
  GetLogsReturnType,
  PublicClient,
  createPublicClient,
  defineChain,
  http,
} from 'viem';
import { AppConfigService } from '../config/app-config.service';
import {
  ACCESS_CONTROL_ABI,
  ENGINE_VIEW_ABI,
  ENGINE_PRICE_VIEW,
  OPTIMISTIC_RESOLVER_VIEW,
} from './abis';

/** Thin viem wrapper: one HTTP public client + read helpers used by the indexer. */
@Injectable()
export class ChainService implements OnModuleInit {
  private readonly logger = new Logger(ChainService.name);
  private client: PublicClient | null = null;
  /** Separate transport for the timestamp burst — see `onModuleInit`. */
  private timestampClient: PublicClient | null = null;
  private readonly blockTsCache = new Map<string, number>();

  constructor(private readonly cfg: AppConfigService) {}

  onModuleInit(): void {
    const { httpUrl, chainId } = this.cfg.chain;
    if (!httpUrl) {
      this.logger.warn('no RPC_HTTP_URL configured — chain reads disabled');
      return;
    }
    const chain: Chain = defineChain({
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [httpUrl] } },
    });
    // Retry on both clients, because a single dropped request used to kill the
    // whole tick. The cursor only advances on a fully committed batch, so a
    // retry is always safe — worst case it re-reads a range it has seen.
    const retry = { retryCount: 5, retryDelay: 250, timeout: 20_000 } as const;

    // Unbatched, and deliberately so. JSON-RPC batching coalesces concurrent
    // calls into ONE HTTP request that the node answers serially, which turns
    // parallel `getLogs` into a queue: measured against Monad's public RPC,
    // 8 concurrent 100-block ranges ran at 223 blocks/sec batched versus 450
    // unbatched, and 24 ranges timed out entirely batched while reaching 1,248
    // blocks/sec unbatched. Catch-up after an outage is exactly when this
    // matters, so the heavy calls get their own un-coalesced transport.
    this.client = createPublicClient({ chain, transport: http(httpUrl, retry) });

    // Batched, for the opposite shape of traffic: one indexing pass asks for a
    // block timestamp per block that carried a log, which is a burst of dozens
    // of tiny identical requests. Coalescing those is the difference between
    // keeping up and being rate-limited into silence.
    this.timestampClient = createPublicClient({
      chain,
      transport: http(httpUrl, { ...retry, batch: { wait: 16 } }),
    });
    this.logger.log(`chain client ready (chainId=${chainId})`);
  }

  get isReady(): boolean {
    return this.client !== null;
  }

  private require(): PublicClient {
    if (!this.client) throw new Error('chain client not configured');
    return this.client;
  }

  async getBlockNumber(): Promise<bigint> {
    return this.require().getBlockNumber();
  }

  /** Decoded logs for a single event ABI over a block range on one address. */
  async getLogs(
    address: `0x${string}`,
    events: Abi,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<GetLogsReturnType> {
    return this.require().getLogs({
      address,
      events: events.filter((a): a is AbiEvent => a.type === 'event'),
      fromBlock,
      toBlock,
    });
  }

  /** Block unix-seconds, memoized (many logs share a block). */
  async getBlockTimestamp(blockNumber: bigint): Promise<number> {
    const key = blockNumber.toString();
    const cached = this.blockTsCache.get(key);
    if (cached !== undefined) return cached;
    const block = await (this.timestampClient ?? this.require()).getBlock({ blockNumber });
    const ts = Number(block.timestamp);
    if (this.blockTsCache.size > 5000) this.blockTsCache.clear();
    this.blockTsCache.set(key, ts);
    return ts;
  }

  /** Read the authoritative LMSR price vector (WAD, sums to 1e18). */
  async readPrices(address: `0x${string}`, marketId: bigint): Promise<bigint[]> {
    const result = await this.require().readContract({
      address,
      abi: ENGINE_PRICE_VIEW,
      functionName: 'prices',
      args: [marketId],
    });
    return [...(result as readonly bigint[])];
  }

  /**
   * A no-argument view returning one `uint256`.
   *
   * There are enough of these on the shielded pool — `SCOPE`, `currentRoot`, `latestRoot`,
   * `rootIndex` — that a helper beats four near-identical wrappers, and the ABI travels with the
   * call so nothing here needs to know which contract it is talking to.
   */
  async readUint(address: `0x${string}`, abi: Abi, functionName: string): Promise<bigint> {
    return (await this.require().readContract({ address, abi, functionName })) as bigint;
  }

  /**
   * AccessControl `hasRole` on a contract. This is the single source of truth
   * for admin authorization — the backend keeps no role table of its own, so
   * on-chain grants/revokes take effect immediately with no risk of drift.
   */
  async hasRole(
    contract: `0x${string}`,
    role: `0x${string}`,
    account: `0x${string}`,
  ): Promise<boolean> {
    return (await this.require().readContract({
      address: contract,
      abi: ACCESS_CONTROL_ABI,
      functionName: 'hasRole',
      args: [role, account],
    })) as boolean;
  }

  /** Where a market's resolution surplus is swept. */
  async readFeeRecipient(contract: `0x${string}`): Promise<`0x${string}`> {
    return (await this.require().readContract({
      address: contract,
      abi: ENGINE_VIEW_ABI,
      functionName: 'feeRecipient',
    })) as `0x${string}`;
  }

  /** Whether an engine is currently paused (betting halted). */
  async readPaused(contract: `0x${string}`): Promise<boolean> {
    return (await this.require().readContract({
      address: contract,
      abi: ENGINE_VIEW_ABI,
      functionName: 'paused',
    })) as boolean;
  }

  /**
   * What it currently costs to propose or dispute a market's outcome, and what being right pays.
   *
   * Read live rather than cached anywhere. Both figures move with the book — the bond is a share
   * of the pot, the reward a share of the fees that market has earned — so a number stored at
   * proposal time would be stale by the time a trader saw it, and quoting a stale bond means
   * quoting a price the chain will not accept.
   *
   * The five reads are issued together; `ChainService`'s transport batches them into one request.
   */
  async readResolutionTerms(
    resolver: `0x${string}`,
    market: `0x${string}`,
    marketId: bigint,
  ): Promise<{
    bond: bigint;
    reward: bigint;
    fee: bigint;
    disputeWindowSeconds: number;
    rewardPool: bigint;
  }> {
    const client = this.require();
    const [bond, reward, fee, disputeWindow, rewardPool] = await Promise.all([
      client.readContract({
        address: resolver,
        abi: OPTIMISTIC_RESOLVER_VIEW,
        functionName: 'bond',
      }),
      client.readContract({
        address: resolver,
        abi: OPTIMISTIC_RESOLVER_VIEW,
        functionName: 'rewardFor',
        args: [market, marketId],
      }),
      client.readContract({
        address: resolver,
        abi: OPTIMISTIC_RESOLVER_VIEW,
        functionName: 'proposalFee',
      }),
      client.readContract({
        address: resolver,
        abi: OPTIMISTIC_RESOLVER_VIEW,
        functionName: 'disputeWindow',
      }),
      client.readContract({
        address: resolver,
        abi: OPTIMISTIC_RESOLVER_VIEW,
        functionName: 'rewardPool',
      }),
    ]);
    return {
      bond: bond as bigint,
      reward: reward as bigint,
      fee: fee as bigint,
      disputeWindowSeconds: Number(disputeWindow as bigint),
      rewardPool: rewardPool as bigint,
    };
  }
}
