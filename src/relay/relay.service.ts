import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  Chain,
  PublicClient,
  WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
  toFunctionSelector,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { AppConfigService } from '../config/app-config.service';
import { RedisService } from '../redis/redis.service';
import {
  FORWARDER_ABI,
  PERMIT_ABI,
  RELAYABLE_SIGNATURES,
  RESOLUTION_FORWARDER_ABI,
  RESOLUTION_SIGNATURES,
} from './relay.abi';
import type { PermitRequestDto, RelayRequestDto } from './dto/relay.dto';

type PermitRequest = PermitRequestDto;

/**
 * How many times the boot wiring check may retry, and how long it waits first.
 *
 * Five attempts at 400ms doubling reaches ~12 seconds, which comfortably outlasts the burst of
 * indexer traffic that caused the failure this exists for. Beyond that the problem is not
 * transient and the relay should say so rather than pretend.
 */
const WIRING_RETRIES = 5;
const WIRING_RETRY_BASE_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


/**
 * Numera's gas relay.
 *
 * ## Why this endpoint has no authentication, and what replaces it
 *
 * Traders bet from a per-market address derived in their browser, funded by a shielded-pool
 * withdrawal whose source is private. That address is unlinkable exactly as long as nothing public
 * ties it to the user — and gas is what ties it. If a user's wallet ever sent their market account
 * so much as dust for gas, the transfer would publish the association permanently and retroactively
 * for every position that account will ever hold.
 *
 * So market accounts never hold gas. They sign, and this service sends.
 *
 * Which creates the obvious problem: an endpoint that will pay for anyone's transaction. The
 * obvious fix — require a session — is the one fix that is not available, because a session would
 * let *these logs* record "user X moved account Y". That is the same link, rebuilt on our own
 * infrastructure, and it would be worse than the on-chain one because we would be the ones keeping
 * it. This endpoint therefore accepts a signature and nothing else: no cookie, no token, no user id.
 *
 * What takes authentication's place, in order of strength:
 *
 *  1. **Structural, on chain.** `NumeraForwarder` has exactly one destination, frozen at deploy,
 *     and four permitted selectors. It cannot relay to anything else *whatever this service does* —
 *     including if this service's key is stolen outright. That is the guarantee that matters.
 *  2. **Economic, on chain.** `LsLmsrMarket.minTradeCost` makes every relayable trade carry a fee
 *     worth several times its own gas. Nothing distinguishes an attacker's trade from an honest one
 *     — they are both real trades — so the bound has to be arithmetic rather than an identity check.
 *  3. **Cost caps, here.** Everything below. These bound spend; they do not bound capability, and
 *     they are the layer that fails first and least catastrophically.
 *
 * ## The Monad-specific part
 *
 * Monad bills the gas **limit**, not the gas used — measured across 14 mainnet transactions. So the
 * gas limit on a relayed transaction is a direct spend authorisation, and the single most dangerous
 * thing this service could do is honour a limit that arrived with the request. It does not: the
 * limit comes from simulation, capped by config, and the fee cap is ours too.
 *
 * ## The residual, stated plainly
 *
 * A caller who supplies their own IP and their own collateral can still make marginally profitable
 * trades at our expense. The fee floor bounds it. Authentication would not fix it, and would cost
 * the product its reason to exist.
 */
@Injectable()
export class RelayService implements OnModuleInit {
  private readonly log = new Logger(RelayService.name);

  private rpc: PublicClient | null = null;
  private wallet: WalletClient | null = null;
  private account: PrivateKeyAccount | null = null;
  private engine: `0x${string}` | null = null;
  /** The only spenders a relayed approval may name. Frozen at boot. */
  private permitSpenders = new Set<string>();
  private selectors = new Set<string>();

  /**
   * The resolution relay, or null when it is not configured or failed its boot check.
   *
   * Deliberately a separate destination and a separate selector set, sharing one relayer key. The
   * sharing is not an optimisation: two services sending from the same EOA race on the nonce, and
   * the loser is dropped by the node with an error that looks nothing like its cause. One queue,
   * one key. See {@link queue}.
   *
   * Its failure is also deliberately non-fatal for trading. Sponsoring proposals and sponsoring
   * trades are separate products, and a misconfigured resolver should not take the book offline.
   */
  private resolutionForwarder: `0x${string}` | null = null;
  private resolutionResolver: `0x${string}` | null = null;
  private resolutionSelectors = new Set<string>();

  /**
   * Serialises submissions.
   *
   * Two concurrent sends from one EOA race on the nonce, and the loser is dropped by the node with
   * an error that looks nothing like its cause. A promise chain is enough because throughput here
   * is bounded by the trade minimum, not by us. Running more than one instance needs a key per
   * instance rather than a bigger queue.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: AppConfigService,
    private readonly redis: RedisService,
  ) {}

  get isEnabled(): boolean {
    return this.cfg.relay.enabled && this.rpc !== null && this.wallet !== null;
  }

  get relayerAddress(): string | null {
    return this.account?.address ?? null;
  }

  async onModuleInit(): Promise<void> {
    const { relay, chain } = this.cfg;
    if (!relay.enabled) {
      this.log.log('gas relay disabled');
      return;
    }
    if (!relay.privateKey || !relay.forwarder || !chain.httpUrl) {
      this.log.error('gas relay enabled but not configured — refusing to relay');
      return;
    }

    const viemChain: Chain = defineChain({
      id: chain.chainId,
      name: `chain-${chain.chainId}`,
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [chain.httpUrl] } },
    });

    this.account = privateKeyToAccount(relay.privateKey);
    this.rpc = createPublicClient({ chain: viemChain, transport: http(chain.httpUrl) });
    this.wallet = createWalletClient({
      account: this.account,
      chain: viemChain,
      transport: http(chain.httpUrl),
    });
    this.selectors = new Set(RELAYABLE_SIGNATURES.map((s) => toFunctionSelector(`function ${s}`)));
    this.resolutionSelectors = new Set(
      RESOLUTION_SIGNATURES.map((s) => toFunctionSelector(`function ${s}`)),
    );

    await this.verifyWiring();
    await this.verifyResolutionWiring();
  }

  /** Whether a market account can propose or dispute an outcome without holding gas. */
  get isResolutionEnabled(): boolean {
    return this.isEnabled && this.resolutionForwarder !== null;
  }

  /**
   * Confirm at boot what every request would otherwise discover one at a time.
   *
   * A forwarder pointed at a different engine, or one whose allowlist disagrees with ours, makes
   * every trade fail with an on-chain revert the user cannot act on. Better to say so once, here.
   *
   * Retried, because this used to be one-shot and one-shot was wrong. The check runs at boot, which
   * is exactly when the indexers are crawling hardest and most likely to have the shared RPC
   * answering `requests limited to 25/sec`. A rate-limited read then disabled gasless trading for
   * the whole process lifetime — no bet possible anywhere in the app — and the only cure was a
   * restart nobody knew to perform, because the log line said "refusing to relay" and read like a
   * deliberate safety decision rather than a transient failure.
   *
   * A genuinely misconfigured forwarder still fails permanently, and should: those paths set
   * `wallet = null` and return rather than throwing, so they are not retried.
   */
  private async verifyWiring(attempt = 0): Promise<void> {
    const { relay, chain } = this.cfg;
    try {
      const market = await this.rpc!.readContract({
        address: relay.forwarder as `0x${string}`,
        abi: FORWARDER_ABI,
        functionName: 'market',
      });
      if (market === '0x0000000000000000000000000000000000000000') {
        this.log.error('forwarder is not initialized — no destination set; relay will reject all');
        this.wallet = null;
        return;
      }
      if (
        chain.addresses.lsLmsr &&
        market.toLowerCase() !== chain.addresses.lsLmsr.toLowerCase()
      ) {
        this.log.error(
          `forwarder targets ${market} but LS_LMSR_MARKET_ADDRESS is ${chain.addresses.lsLmsr} — refusing to relay`,
        );
        this.wallet = null;
        return;
      }
      this.engine = market;
      // Two, and only two. The engine, so a market account can be pulled from when it trades; and
      // Permit2, because the shielded pool's deposit path needs an allowance the account cannot
      // grant itself — it holds no gas and can never send `approve`.
      this.permitSpenders = new Set([market.toLowerCase()]);
      if (relay.permit2) this.permitSpenders.add(relay.permit2.toLowerCase());

      // Cross-check the allowlist rather than trusting two copies of it to agree.
      for (const selector of this.selectors) {
        const ok = await this.rpc!.readContract({
          address: relay.forwarder as `0x${string}`,
          abi: FORWARDER_ABI,
          functionName: 'isRelayable',
          args: [selector as `0x${string}`],
        });
        if (!ok) {
          this.log.error(`forwarder rejects selector ${selector} that this service allows`);
          this.wallet = null;
          return;
        }
      }

      const balance = await this.rpc!.getBalance({ address: this.account!.address });
      this.log.log(
        `gas relay ready — relayer ${this.account!.address} holds ${formatEther(balance)} MON, engine ${market}`,
      );
      if (balance < relay.minBalanceWei) {
        this.log.warn(
          `relayer balance ${formatEther(balance)} MON is below the ${formatEther(relay.minBalanceWei)} MON floor`,
        );
      }
    } catch (err) {
      if (attempt < WIRING_RETRIES) {
        const delay = WIRING_RETRY_BASE_MS * 2 ** attempt;
        this.log.warn(
          `could not verify forwarder wiring (${describeRevert(err)}) — retrying in ${delay}ms`,
        );
        await sleep(delay);
        return this.verifyWiring(attempt + 1);
      }
      this.log.error('could not verify forwarder wiring — refusing to relay', err as Error);
      this.wallet = null;
    }
  }

  /**
   * The same boot check for the resolution relay, with one difference: failing it disables only
   * resolution relaying, never trading.
   *
   * A proposer who cannot be sponsored has a workable fallback — they can send the transaction
   * themselves and give up the privacy — whereas a trader who cannot be sponsored has none, because
   * funding a market account publicly is exactly what the design forbids. So the two failures are
   * not equally bad, and this one is a warning rather than a shutdown.
   */
  private async verifyResolutionWiring(attempt = 0): Promise<void> {
    const { relay, chain } = this.cfg;
    if (!relay.resolutionForwarder) {
      this.log.log('resolution relay not configured — proposals will not be sponsored');
      return;
    }
    const forwarder = relay.resolutionForwarder as `0x${string}`;
    try {
      const resolver = await this.rpc!.readContract({
        address: forwarder,
        abi: RESOLUTION_FORWARDER_ABI,
        functionName: 'resolver',
      });
      if (resolver === '0x0000000000000000000000000000000000000000') {
        this.log.error('resolution forwarder is not initialized — proposals will not be sponsored');
        return;
      }
      if (
        chain.addresses.optimisticResolver &&
        resolver.toLowerCase() !== chain.addresses.optimisticResolver.toLowerCase()
      ) {
        this.log.error(
          `resolution forwarder targets ${resolver} but OPTIMISTIC_RESOLVER_ADDRESS is ` +
            `${chain.addresses.optimisticResolver} — refusing to relay proposals`,
        );
        return;
      }

      // Same cross-check as trading: two copies of an allowlist drift, and the one on chain wins.
      for (const selector of this.resolutionSelectors) {
        const ok = await this.rpc!.readContract({
          address: forwarder,
          abi: RESOLUTION_FORWARDER_ABI,
          functionName: 'isRelayable',
          args: [selector as `0x${string}`],
        });
        if (!ok) {
          this.log.error(`resolution forwarder rejects selector ${selector} that this service allows`);
          return;
        }
      }

      this.resolutionForwarder = forwarder;
      this.resolutionResolver = resolver;
      this.log.log(`resolution relay ready — resolver ${resolver}`);
    } catch (err) {
      // Retried for the same reason as the trading check: this runs at boot, which is when the
      // indexers are crawling hardest, and a rate-limited read left sponsored resolution off for
      // the whole process lifetime. Sponsoring proposals is how a trader disputes an outcome
      // without publishing which account holds the position — losing it silently costs the
      // privacy of exactly the people most motivated to challenge a bad settlement.
      if (attempt < WIRING_RETRIES) {
        const delay = WIRING_RETRY_BASE_MS * 2 ** attempt;
        this.log.warn(
          `could not verify resolution wiring (${describeRevert(err)}) — retrying in ${delay}ms`,
        );
        await sleep(delay);
        return this.verifyResolutionWiring(attempt + 1);
      }
      this.log.error('could not verify resolution forwarder wiring', err as Error);
    }
  }

  /**
   * Sponsor a signed proposal or dispute.
   *
   * Same unauthenticated shape as {@link submit}, and for the same reason: whoever proposes an
   * outcome is overwhelmingly someone holding it, so a proposal signed by a login wallet would
   * publish which side that wallet is on. The proposal therefore comes from the trader's market
   * account, which holds no gas, and we send it.
   *
   * The economics are stronger here than for trading. Both relayable calls stake a bond in the same
   * transaction, so there is no such thing as a free proposal — a spammer locks collateral worth
   * many times the gas they are costing us, and only gets it back by being right.
   */
  async submitResolution(payload: RelayRequestDto): Promise<{ hash: string }> {
    if (!this.isEnabled) throw new RelayRejected('unavailable', 'Gasless actions are not available.');
    if (!this.resolutionForwarder) {
      throw new RelayRejected('unavailable', 'Sponsored resolution is not available.');
    }

    const request = this.toContractRequest(payload);

    if (request.to.toLowerCase() !== this.resolutionResolver!.toLowerCase()) {
      throw new RelayRejected('invalid', 'This relayer only submits resolutions to the Numera resolver.');
    }
    if (request.value !== 0n) {
      throw new RelayRejected('invalid', 'Relayed resolutions never carry native value.');
    }
    if (request.gas > this.cfg.relay.maxGas) {
      throw new RelayRejected('invalid', 'This request asks for more gas than the relayer allows.');
    }
    if (
      request.data.length < 10 ||
      !this.resolutionSelectors.has(request.data.slice(0, 10).toLowerCase())
    ) {
      throw new RelayRejected('invalid', 'Only proposing and disputing can be relayed here.');
    }
    // A permit for somebody else bundled with your own proposal is the shape of "make them pay for
    // my approval". The spender needs no check: `executeWithPermit` hardcodes the resolver, so a
    // bundled approval structurally cannot name anything else.
    if (payload.permit && payload.permit.owner.toLowerCase() !== request.from.toLowerCase()) {
      throw new RelayRejected('invalid', 'A relayed approval must belong to the proposing account.');
    }

    await this.enforceAccountRate(request.from);
    await this.enforceDailyCap();

    const valid = await this.rpc!
      .readContract({
        address: this.resolutionForwarder,
        abi: RESOLUTION_FORWARDER_ABI,
        functionName: 'verifyRelayable',
        args: [request],
      })
      .catch(() => false);
    if (!valid) {
      throw new RelayRejected(
        'invalid',
        'This request could not be verified. It may have expired, or already been submitted.',
      );
    }

    return this.enqueue(() => this.simulateAndSend(payload, request, this.resolutionForwarder!));
  }

  /**
   * Submit a standalone EIP-2612 approval.
   *
   * The one place a permit is relayed on its own, and it exists because a market account holds no
   * native gas and therefore cannot send `approve` — yet the shielded pool's deposit path needs a
   * Permit2 allowance before it will move anything. Without this the return leg is impossible: a
   * trader could fund a market and never get the money back out.
   *
   * `permit` is permissionless by design, so the abuse question is "who else can make us pay for
   * their approvals". The answer is bounded by {permitSpenders}: an approval can only ever name our
   * engine or Permit2, and an allowance granted by an account with no balance is worth nothing.
   */
  async submitPermit(permit: PermitRequest): Promise<{ hash: string }> {
    if (!this.isEnabled) throw new RelayRejected('unavailable', 'Gasless trading is not available.');
    if (!this.permitSpenders.has(permit.spender.toLowerCase())) {
      throw new RelayRejected('invalid', 'This relayer only approves the Numera engine and Permit2.');
    }

    await this.enforceAccountRate(permit.owner);
    await this.enforceDailyCap();

    const data = encodeFunctionData({
      abi: PERMIT_ABI,
      functionName: 'permit',
      args: [
        permit.owner as `0x${string}`,
        permit.spender as `0x${string}`,
        BigInt(permit.value),
        BigInt(permit.deadline),
        permit.v,
        permit.r as `0x${string}`,
        permit.s as `0x${string}`,
      ],
    });

    return this.enqueue(async () => {
      const token = permit.token as `0x${string}`;
      let gas: bigint;
      try {
        await this.rpc!.call({ account: this.account!.address, to: token, data });
        gas = await this.rpc!.estimateGas({ account: this.account!.address, to: token, data });
      } catch (err) {
        this.log.warn(`permit simulation failed for ${permit.owner}: ${describeRevert(err)}`);
        throw new RelayRejected(
          'rejected',
          'That approval could not be applied. Nothing was sent and nothing was spent.',
          err,
        );
      }

      const { limit, maxFeePerGas, maxPriorityFeePerGas } = await this.gasFor(gas);
      const hash = await this.wallet!.sendTransaction({
        account: this.account!,
        chain: this.wallet!.chain,
        to: token,
        data,
        gas: limit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      await this.recordSpend(limit * maxFeePerGas);
      this.log.log(`relayed permit for ${permit.owner} -> ${permit.spender} — ${hash}`);
      return { hash };
    });
  }

  /**
   * Validate, simulate, and submit one signed request.
   *
   * Ordered cheapest-check-first so junk costs us nothing: shape, then our own caps, then one
   * `eth_call` to the forwarder's own verifier, then a simulation, and only then a transaction.
   */
  async submit(payload: RelayRequestDto): Promise<{ hash: string }> {
    if (!this.isEnabled) throw new RelayRejected('unavailable', 'Gasless trading is not available.');

    const request = this.toContractRequest(payload);

    // --- free checks, no chain call -------------------------------------------------
    if (request.to.toLowerCase() !== this.engine!.toLowerCase()) {
      throw new RelayRejected('invalid', 'This relayer only submits trades to the Numera engine.');
    }
    if (request.value !== 0n) {
      throw new RelayRejected('invalid', 'Relayed trades never carry native value.');
    }
    if (request.gas > this.cfg.relay.maxGas) {
      throw new RelayRejected('invalid', 'This request asks for more gas than the relayer allows.');
    }
    if (request.data.length < 10 || !this.selectors.has(request.data.slice(0, 10).toLowerCase())) {
      throw new RelayRejected('invalid', 'Only buy, sell and redeem can be relayed.');
    }
    if (payload.permit && payload.permit.owner.toLowerCase() !== request.from.toLowerCase()) {
      // A permit for somebody else bundled with your own trade is the shape of "make them pay for
      // my approval". The two must be the same account.
      throw new RelayRejected('invalid', 'A relayed approval must belong to the trading account.');
    }

    // --- cost bounds ----------------------------------------------------------------
    await this.enforceAccountRate(request.from);
    await this.enforceDailyCap();

    // --- the chain's own opinion, in one call ---------------------------------------
    const valid = await this.rpc!.readContract({
      address: this.cfg.relay.forwarder as `0x${string}`,
      abi: FORWARDER_ABI,
      functionName: 'verifyRelayable',
      args: [request],
    }).catch(() => false);
    // A permit that has not landed yet legitimately fails nothing here — `verifyRelayable` checks
    // signature, nonce, deadline, target and selector, none of which depend on the allowance.
    if (!valid) {
      throw new RelayRejected(
        'invalid',
        'This trade could not be verified. It may have expired, or already been submitted.',
      );
    }

    return this.enqueue(() =>
      this.simulateAndSend(payload, request, this.cfg.relay.forwarder as `0x${string}`),
    );
  }

  /**
   * Send a call the platform is making on its own behalf, not on anyone's.
   *
   * Everything else here forwards a signature somebody else produced. This does not: the relayer is
   * the actual sender, and the call is one that belongs to no user — settling a proposal whose
   * challenge window has passed, which is permissionless and pays the recorded proposer whoever
   * sends it. There is no `from` to check and no signature to verify, so the caller must be a
   * service inside this process rather than anything reachable over HTTP.
   *
   * It lives here, rather than in a service with its own wallet, for the reason stated on
   * {@link queue}: two senders on one EOA race on the nonce and the loser is dropped by the node
   * with an error that looks nothing like its cause. One key, one queue, no exceptions.
   *
   * Simulated first like every other send, which also makes duplicate work free: a proposal that
   * was already settled reverts in simulation and nothing is broadcast.
   */
  async sendFromRelayer(
    to: `0x${string}`,
    data: `0x${string}`,
    label: string,
  ): Promise<`0x${string}`> {
    if (!this.isEnabled) {
      throw new RelayRejected('unavailable', 'The relay is not available. Nothing was sent.');
    }
    await this.enforceDailyCap();

    return this.enqueue(async () => {
      let gas: bigint;
      try {
        await this.rpc!.call({ account: this.account!.address, to, data });
        gas = await this.rpc!.estimateGas({ account: this.account!.address, to, data });
      } catch (err) {
        const reason = revertReason(err);
        // Logged as well as thrown. The message that reaches the caller is deliberately vague —
        // it is rendered to a user — and a custom error the decoder does not know produces the
        // generic fallback, which then says nothing to anyone. The `permit` path already logged
        // its failures for exactly this reason; this one did not, and a `relay` rejected in
        // simulation was indistinguishable from a relayer that had simply stopped working.
        this.log.warn(`${label} rejected in simulation: ${describeRevert(err)}`);
        throw new RelayRejected(
          'rejected',
          reason?.user ?? 'The contract rejected this call. Nothing was sent and nothing was spent.',
          err,
        );
      }

      const { limit, maxFeePerGas, maxPriorityFeePerGas } = await this.gasFor(gas);
      const hash = await this.wallet!.sendTransaction({
        account: this.account!,
        chain: this.wallet!.chain,
        to,
        data,
        gas: limit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });

      await this.recordSpend(limit * maxFeePerGas);
      this.log.log(`sent ${label} — ${hash}`);
      return hash;
    });
  }

  /** Wait for a sent transaction to land. Outside the nonce queue, which must never block on this. */
  async receiptFor(hash: `0x${string}`): Promise<{ status: 'success' | 'reverted' } | null> {
    if (!this.rpc) return null;
    return this.rpc
      .waitForTransactionReceipt({ hash, timeout: 60_000 })
      .then((r) => ({ status: r.status }))
      .catch(() => null);
  }

  /**
   * @param forwarder Which relay to send through. Both forwarders expose an identical `execute` and
   *        `executeWithPermit`, so one send path serves both — and, more importantly, both go
   *        through the one nonce queue that makes concurrent sends from this key safe.
   */
  private async simulateAndSend(
    payload: RelayRequestDto,
    request: ContractRequest,
    forwarder: `0x${string}`,
  ): Promise<{ hash: string }> {
    const permit = payload.permit;

    // Encoded once, then sent as raw calldata. A relayer forwards bytes; going through the typed
    // contract helpers would buy nothing here and forces the two entry points into a union that
    // viem cannot infer across.
    const data = permit
      ? encodeFunctionData({
          abi: FORWARDER_ABI,
          functionName: 'executeWithPermit',
          args: [
            permit.owner as `0x${string}`,
            BigInt(permit.value),
            BigInt(permit.deadline),
            permit.v,
            permit.r as `0x${string}`,
            permit.s as `0x${string}`,
            request,
          ],
        })
      : encodeFunctionData({ abi: FORWARDER_ABI, functionName: 'execute', args: [request] });

    // Simulate first. A request that would revert is dropped for free, so failed spam costs the
    // sender and not us — which is most of what makes an open endpoint affordable.
    let gas: bigint;
    try {
      await this.rpc!.call({ account: this.account!.address, to: forwarder, data });
      gas = await this.rpc!.estimateGas({ account: this.account!.address, to: forwarder, data });
    } catch (err) {
      const reason = revertReason(err);
      this.log.warn(`simulation failed for ${request.from}: ${reason?.log ?? 'no revert data'}`);
      // The sender gets the real cause when we recognise it.
      //
      // This used to return one sentence for every possible revert, which turned an account with
      // no collateral into "somebody may have got there first" by the time the client had finished
      // guessing. Nothing here is a secret: these are public contract errors about a public
      // address, and the sender is the only party who cannot already see them.
      throw new RelayRejected(
        'rejected',
        reason?.user
          ? `${reason.user} Nothing was sent and nothing was spent.`
          : 'The contract rejected this request. Nothing was sent and nothing was spent.',
        err,
      );
    }

    const { limit, maxFeePerGas, maxPriorityFeePerGas } = await this.gasFor(gas);

    const hash = await this.wallet!.sendTransaction({
      account: this.account!,
      chain: this.wallet!.chain,
      to: forwarder,
      data,
      gas: limit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    // Charged against the daily cap at the limit rather than at actual usage, because that is what
    // Monad bills and because the receipt has not arrived yet. Over-counting is the safe direction.
    await this.recordSpend(limit * maxFeePerGas);
    // `from` is a public on-chain address and is logged; nothing that could identify its owner ever
    // reaches this log, because nothing that could identify its owner ever reaches this service.
    this.log.log(`relayed ${request.data.slice(0, 10)} for ${request.from} — ${hash}`);
    return { hash };
  }

  /**
   * The gas policy, shared by every path that sends.
   *
   * Refuses rather than clamps. Capping a limit below what simulation says the call needs sends a
   * transaction that is *guaranteed* to run out of gas — and Monad bills the full limit for it, so
   * the silent version of this failure costs the most and explains the least.
   */
  private async gasFor(
    estimate: bigint,
  ): Promise<{ limit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    /*
      Headroom for the block landing in a slightly different state than it simulated against —
      proportional, but bounded.

      This was a flat 20%, which is right for a 300,000-gas trade and wrong for a shielded
      withdrawal. A Groth16 verification plus a tree insert plus two transfers estimates around
      1.6M, and 20% of that is 320,000 gas of headroom. On Monad, where the *limit* is billed
      rather than the gas used, that is not a safety margin — it is a third of a MON thrown away on
      every withdrawal, forever.

      Ten percent capped at 200,000 keeps the generous margin where calls are small and variable,
      and stops it scaling into pure waste on the large deterministic ones. The variance being
      covered is storage warmth and tree depth, neither of which grows with the size of the call.
    */
    const headroom = bigintMin(estimate / 10n, 200_000n);
    const limit = estimate + headroom;
    if (limit > this.cfg.relay.maxGas) {
      this.log.error(
        `call needs ${limit} gas, above RELAY_MAX_GAS=${this.cfg.relay.maxGas} — raise the cap`,
      );
      throw new RelayRejected(
        'unavailable',
        'This operation is larger than the relayer is configured to sponsor. Nothing was spent.',
      );
    }

    const fees = await this.rpc!.estimateFeesPerGas().catch(() => null);
    const maxFeePerGas = bigintMin(
      fees?.maxFeePerGas ?? this.cfg.relay.maxFeePerGas,
      this.cfg.relay.maxFeePerGas,
    );
    return {
      limit,
      maxFeePerGas,
      maxPriorityFeePerGas: bigintMin(fees?.maxPriorityFeePerGas ?? 1_000_000_000n, maxFeePerGas),
    };
  }

  /**
   * Per-account request rate.
   *
   * Anti-accident rather than anti-attack, and worth being honest about why: market accounts are
   * derived keypairs, so an attacker mints as many as they like and this bounds none of them. What
   * it does catch is a retry loop in the client, which is the failure that actually happens.
   */
  private async enforceAccountRate(account: string): Promise<void> {
    const { accountLimit, accountWindowSeconds } = this.cfg.relay;
    const key = `relay:rate:${account.toLowerCase()}`;
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, accountWindowSeconds);
    if (count > accountLimit) {
      throw new RelayRejected(
        'rate-limited',
        'Too many trades from this account in a short time. Wait a moment and try again.',
      );
    }
  }

  /** A hard ceiling that fails closed, so a novel attack costs at most one day of gas. */
  private async enforceDailyCap(): Promise<void> {
    const spent = await this.spentTodayWei();
    if (spent >= this.cfg.relay.dailyCapWei) {
      this.log.error(
        `daily relay cap reached (${formatEther(spent)} MON) — refusing further requests`,
      );
      throw new RelayRejected(
        'unavailable',
        'Gasless trading is paused for today. Nothing was spent from your balance.',
      );
    }
  }

  private async recordSpend(wei: bigint): Promise<void> {
    const key = this.spendKey();
    const total = await this.redis.client.incrby(key, Number(wei / GWEI));
    await this.redis.client.expire(key, 172_800);

    // Alert on the *rate*, not the balance. A drain shows up here long before the balance runs
    // out — watching only the balance is how the previous relayer kept surprising us at 0.67 MON.
    const spentWei = BigInt(total) * GWEI;
    const cap = this.cfg.relay.dailyCapWei;
    if (spentWei > (cap * 80n) / 100n) {
      this.log.warn(`relay spend at ${formatEther(spentWei)} MON of a ${formatEther(cap)} MON cap`);
    }
  }

  /**
   * Today's relayed spend, in wei.
   *
   * The counter is stored in **gwei** because Redis `INCRBY` takes a JS number, and a day of gas in
   * wei overflows `Number.MAX_SAFE_INTEGER`. Every reader goes through here so the conversion
   * happens in exactly one place — reading the raw counter as wei silently raises the daily cap by
   * a factor of a billion, which is a cap that never fires and nobody notices until it matters.
   */
  private async spentTodayWei(): Promise<bigint> {
    const gwei = BigInt((await this.redis.client.get(this.spendKey())) ?? '0');
    return gwei * GWEI;
  }

  private spendKey(): string {
    return `relay:spend:${new Date().toISOString().slice(0, 10)}`;
  }

  /**
   * The relayer's balance, read at most this often.
   *
   * The public state endpoint is polled by every open tab, and without this each poll was its own
   * `eth_getBalance`. The figure moves by one trade's gas at a time and is consumed as a threshold
   * rather than a reading, so a few seconds of staleness changes no answer this service gives.
   */
  private static readonly BALANCE_TTL_MS = 15_000;
  private balanceRead: { at: number; wei: bigint | null } | null = null;
  /**
   * The read currently in flight, shared by everyone who arrives during it.
   *
   * Caching only the settled value is not enough. Tabs poll on their own timers and arrive in
   * bursts, and every caller in a burst misses a cache that is not written until the first read
   * returns — so the moment the entry expires, all of them fire their own `eth_getBalance`. The
   * cache would then be busiest exactly when it is least effective.
   */
  private balanceInFlight: Promise<bigint | null> | null = null;

  private async cachedBalance(): Promise<bigint | null> {
    const fresh = this.balanceRead;
    if (fresh && Date.now() - fresh.at < RelayService.BALANCE_TTL_MS) return fresh.wei;
    this.balanceInFlight ??= this.readBalance().finally(() => {
      this.balanceInFlight = null;
    });
    return this.balanceInFlight;
  }

  private async readBalance(): Promise<bigint | null> {
    let wei: bigint | null = null;
    try {
      if (this.rpc && this.account) {
        wei = await this.rpc.getBalance({ address: this.account.address });
      }
    } catch {
      // `try` rather than `.catch()` on the promise: a transport that is missing or misconfigured
      // throws *synchronously* here, before there is a promise to attach a handler to, and this
      // read now sits behind a public endpoint that must not be able to 500.
      wei = null;
    }
    // A failed read is cached too, so an RPC that is down cannot turn one poll per tab into a
    // retry storm against it.
    this.balanceRead = { at: Date.now(), wei };
    return wei;
  }

  /**
   * What a trader is allowed to know: whether a bet can be placed, and nothing else.
   *
   * No address and no figures. A relayer balance is not actionable by anybody reading it here, it
   * is a *lagging* indicator of the thing they care about — see `recordSpend`, where a drain shows
   * up long before the balance does — and published alongside the daily cap it would tell whoever
   * is draining us exactly how close they are and when the counter resets.
   *
   * `available` covers only the two refusals this service actually enforces, and a thin balance is
   * not one of them. The floor is two MON, which is still tens of trades, so refusing there would
   * be a self-inflicted outage on a relayer that works — and reporting "running low" publicly
   * would confirm to whoever is draining us that the drain is landing. A relayer that genuinely
   * runs dry surfaces through the submission path, which already says "nothing was spent, try
   * again shortly". The figure itself belongs to the operator gauge and the alerting around it.
   */
  async publicState(): Promise<{
    available: boolean;
    reason: 'disabled' | 'capped' | null;
    resolution: boolean;
  }> {
    if (!this.isEnabled) return { available: false, reason: 'disabled', resolution: false };
    const capped = (await this.spentTodayWei()) >= this.cfg.relay.dailyCapWei;
    return {
      available: !capped,
      reason: capped ? 'capped' : null,
      resolution: this.isResolutionEnabled,
    };
  }

  /**
   * The full gauge, for operators.
   *
   * Everything `publicState` deliberately withholds. Reachable only through the role-guarded admin
   * route, because this is the reader for whom the numbers change the next action: they are the
   * ones who can top the relayer up.
   */
  async gauge(): Promise<{
    enabled: boolean;
    relayer: string | null;
    balanceWei: string | null;
    spentTodayWei: string;
    dailyCapWei: string;
    minBalanceWei: string;
    lowBalance: boolean;
    resolution: boolean;
  }> {
    const [spentTodayWei, balance] = await Promise.all([this.spentTodayWei(), this.cachedBalance()]);
    return {
      enabled: this.isEnabled,
      relayer: this.relayerAddress,
      balanceWei: balance?.toString() ?? null,
      spentTodayWei: spentTodayWei.toString(),
      dailyCapWei: this.cfg.relay.dailyCapWei.toString(),
      minBalanceWei: this.cfg.relay.minBalanceWei.toString(),
      lowBalance: balance !== null && balance < this.cfg.relay.minBalanceWei,
      resolution: this.isResolutionEnabled,
    };
  }

  private toContractRequest(payload: RelayRequestDto): ContractRequest {
    const r = payload.request;
    return {
      from: r.from as `0x${string}`,
      to: r.to as `0x${string}`,
      value: BigInt(r.value),
      gas: BigInt(r.gas),
      deadline: r.deadline,
      data: r.data as `0x${string}`,
      signature: r.signature as `0x${string}`,
    };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Swallow on the chain itself so one failure does not poison every later submission; the real
    // result still propagates to the caller through `run`.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

interface ContractRequest {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  gas: bigint;
  deadline: number;
  data: `0x${string}`;
  signature: `0x${string}`;
}

export type RelayRejectionCode = 'invalid' | 'rejected' | 'rate-limited' | 'unavailable';

/** Carries a code the frontend can map to a message, and never leaks chain internals to the user. */
export class RelayRejected extends Error {
  constructor(
    readonly code: RelayRejectionCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RelayRejected';
  }
}

const GWEI = 1_000_000_000n;

function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * The engine's and resolver's own errors, so a rejection says what actually happened.
 *
 * Selectors rather than an ABI import: the relayer deliberately knows almost nothing about either
 * contract, and a full ABI here would be a second copy of it to keep in step.
 *
 * `log` goes to us, `user` goes back to whoever sent the request. The split exists because it was
 * previously missing, and the failure that exposed it was this: an account with no collateral
 * proposing a result reverted `ERC20InsufficientBalance`, which we decoded, logged correctly, and
 * then discarded in favour of one generic sentence. The proposer was told somebody had probably
 * got there first. Every `user` string below is public on-chain state, so returning it costs no
 * privacy — the whole point is that the sender can already see it, and only we could read it.
 */
interface RevertReason {
  log: string;
  /** Plain sentence for the sender, or `null` when the cause is ours rather than theirs. */
  user: string | null;
}

const REVERT_REASONS: Record<string, RevertReason> = {
  '0x71c4efed': {
    log: "SlippageExceeded — the price moved past the trader's guard",
    user: 'The price moved past your limit before this landed.',
  },
  '0x38fcec43': {
    log: 'AmountBelowMin — under the minimum trade size',
    user: 'That is below the minimum size for this market.',
  },
  '0xfb8f41b2': {
    log: 'ERC20InsufficientAllowance — the spender was never approved',
    user: 'This account has not approved enough to cover it.',
  },
  '0xe450d38c': {
    log: 'ERC20InsufficientBalance — the account cannot cover it',
    user: 'This market account does not hold enough to cover it.',
  },
  '0x5bd17307': {
    log: 'ProposalExists — a result has already been proposed',
    user: 'Somebody has already proposed a result here. You can dispute it instead.',
  },
  '0x290e4209': {
    log: 'NotDisputable — window closed, or already disputed',
    user: 'This proposal can no longer be disputed. The window has closed, or somebody already did.',
  },
  '0x2ec1bf71': {
    log: 'SameOutcome — the dispute names the proposed outcome',
    user: 'A dispute has to name a different outcome from the one proposed.',
  },
  '0x966a32f7': {
    log: 'MarketNotClosed — still trading',
    user: 'This market is still open for trading, so it cannot be resolved yet.',
  },
  '0x9dc30b8e': {
    log: 'MarketClosed — trading is over',
    user: 'Trading has closed on this market.',
  },
  '0xdfd92da0': {
    log: 'AlreadySettled — the market is already resolved',
    user: 'This market has already been settled.',
  },
  '0xf5ccd95e': {
    log: 'AccountBanned — the account is on the blocklist',
    user: 'This account is barred from trading.',
  },
  '0xeac3a0ea': {
    log: 'InvalidOutcome — outcome index out of range',
    user: 'That is not one of this market’s outcomes.',
  },
};

/**
 * The revert behind a failed simulation, if we recognise it.
 *
 * Walks the cause chain for the revert bytes. viem nests them on the error rather than putting them
 * in the message, so the first version of this greped the text and logged "reverted for an unknown
 * reason" for every failure — which is worse than no log, because it looks like an answer.
 */
function revertReason(err: unknown): RevertReason | null {
  let node: unknown = err;
  for (let depth = 0; node && depth < 8; depth += 1) {
    const data = (node as { data?: unknown }).data;
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      const selector = data.slice(0, 10).toLowerCase();
      return REVERT_REASONS[selector] ?? { log: `unrecognised revert ${selector}`, user: null };
    }
    node = (node as { cause?: unknown }).cause;
  }
  const text = err instanceof Error ? err.message : String(err);
  return { log: text.split('\n')[0], user: null };
}

function describeRevert(err: unknown): string {
  return revertReason(err)?.log ?? 'no revert data';
}
