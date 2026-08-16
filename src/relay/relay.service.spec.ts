import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import { AppConfigService } from '../config/app-config.service';
import { RedisService } from '../redis/redis.service';
import { RELAYABLE_SIGNATURES, RESOLUTION_SIGNATURES } from './relay.abi';
import { RelayRejected, RelayService } from './relay.service';
import type { RelayRequestDto } from './dto/relay.dto';

/**
 * The relay's refusals.
 *
 * This endpoint is deliberately unauthenticated — a session would let our logs record which user
 * owns which market account, which is the exact link the whole privacy design exists to break. So
 * every defence it has is a refusal, and each one below is a way somebody could otherwise spend our
 * gas on something that is not a Numera trade.
 *
 * The contract enforces the same rules and is the guarantee that survives this service being
 * compromised. These checks exist so that a bad request is rejected for free, before it costs an
 * `eth_call`, a simulation, or a transaction.
 */

const ENGINE = '0x1111111111111111111111111111111111111111';
const FORWARDER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const ACCOUNT = '0x9d3591e2b1054670018717bCB0194BE65099B769';
const SIGNATURE = `0x${'ab'.repeat(65)}`;

const ENGINE_ABI = parseAbi([
  'function buy(uint256 marketId, uint256 outcomeId, uint256 sharesOut, uint256 maxCost) returns (uint256)',
  'function redeem(uint256 marketId) returns (uint256)',
]);

const buyData = encodeFunctionData({
  abi: ENGINE_ABI,
  functionName: 'buy',
  args: [1n, 0n, 10_000_000n, 20_000_000n],
});

type RelayConfig = AppConfigService['relay'];

function config(overrides: Partial<RelayConfig> = {}) {
  return {
    relay: {
      enabled: true,
      forwarder: FORWARDER,
      privateKey: `0x${'11'.repeat(32)}` as `0x${string}`,
      maxGas: 700_000n,
      maxFeePerGas: 200_000_000_000n,
      accountLimit: 20,
      accountWindowSeconds: 60,
      dailyCapWei: 50n * 10n ** 18n,
      minBalanceWei: 2n * 10n ** 18n,
      ...overrides,
    },
    chain: { chainId: 10143, httpUrl: 'http://rpc.invalid', addresses: { lsLmsr: ENGINE } },
  } as unknown as AppConfigService;
}

function redis(spentWei = 0n) {
  const store = new Map<string, number>();
  return {
    client: {
      incr: jest.fn(async (k: string) => {
        const next = (store.get(k) ?? 0) + 1;
        store.set(k, next);
        return next;
      }),
      expire: jest.fn(async () => 1),
      get: jest.fn(async () => (spentWei / 1_000_000_000n).toString()),
      incrby: jest.fn(async () => 0),
    },
  } as unknown as RedisService;
}

/**
 * A service wired past `onModuleInit`, which would otherwise need a live RPC.
 *
 * The private fields are set directly rather than exposing setters: production has exactly one way
 * to reach this state — boot, with wiring verified against the chain — and adding a second one just
 * so a test can use it would widen the surface of the one service that must not be widened.
 */
function makeService(opts: { cfg?: AppConfigService; redis?: RedisService } = {}) {
  const svc = new RelayService(opts.cfg ?? config(), opts.redis ?? redis());
  const internals = svc as unknown as {
    rpc: unknown;
    wallet: unknown;
    account: unknown;
    engine: string;
    selectors: Set<string>;
  };
  internals.rpc = { readContract: jest.fn(async () => true) };
  internals.wallet = {};
  internals.account = { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  internals.engine = ENGINE;
  internals.selectors = new Set(
    RELAYABLE_SIGNATURES.map((s) => toFunctionSelector(`function ${s}`)),
  );
  return svc;
}

function payload(overrides: Partial<RelayRequestDto['request']> = {}): RelayRequestDto {
  return {
    request: {
      from: ACCOUNT,
      to: ENGINE,
      value: '0',
      gas: '600000',
      deadline: Math.floor(Date.now() / 1000) + 600,
      data: buyData,
      signature: SIGNATURE,
      ...overrides,
    },
  };
}

async function reject(svc: RelayService, body: RelayRequestDto) {
  return svc.submit(body).catch((e: unknown) => e) as Promise<RelayRejected>;
}

describe('the relay refuses', () => {
  it('any destination but the engine (REGRESSION)', async () => {
    // The whole "this cannot become a general-purpose relayer" claim. The forwarder enforces it
    // immutably; this rejects it for free, before spending an eth_call.
    const err = await reject(makeService(), payload({ to: TOKEN }));
    expect(err).toBeInstanceOf(RelayRejected);
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/only submits trades to the Numera engine/i);
  });

  it('any function outside buy, buyComplement, sell and redeem (REGRESSION)', async () => {
    // Allowlisting the contract is not enough: `createMarket` is the most expensive call on the
    // engine and moves seed capital.
    const createMarket = toFunctionSelector('function createMarket(uint256)');
    const err = await reject(makeService(), payload({ data: `${createMarket}${'00'.repeat(32)}` }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/only buy, sell and redeem/i);
  });

  it('calldata too short to carry a selector (negative)', async () => {
    const err = await reject(makeService(), payload({ data: '0x1234' }));
    expect(err.code).toBe('invalid');
  });

  it('native value (safety)', async () => {
    // The engine is not payable, and a relay that can carry value is a relay that can be drained.
    const err = await reject(makeService(), payload({ value: '1' }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/never carry native value/i);
  });

  it('a gas limit above our own cap (REGRESSION)', async () => {
    // Monad bills the gas *limit*, not the gas used, so a limit that arrived with the request is a
    // spend authorisation written by the caller. Honouring one would drain the relayer in a few
    // hundred transactions.
    const err = await reject(makeService(), payload({ gas: '700001' }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/more gas than the relayer allows/i);
  });

  it('a permit belonging to somebody other than the trader (REGRESSION)', async () => {
    // "Make them pay for my approval", bundled behind a trade the attacker does fund. The permit
    // and the trade must be the same account.
    const body = payload();
    body.permit = {
      owner: '0x000000000000000000000000000000000000dEaD',
      value: '1',
      deadline: '99999999999',
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    };
    const err = await reject(makeService(), body);
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/must belong to the trading account/i);
  });

  it('everything once the daily gas cap is reached (safety)', async () => {
    // Fails closed, so an attack nobody anticipated costs at most one day of gas.
    const svc = makeService({ redis: redis(60n * 10n ** 18n) });
    const err = await reject(svc, payload());
    expect(err.code).toBe('unavailable');
    expect(err.message).toMatch(/paused for today/i);
    expect(err.message).toMatch(/nothing was spent/i);
  });

  it('a flood from one account (negative)', async () => {
    const svc = makeService();
    const results: RelayRejected[] = [];
    for (let i = 0; i < 22; i += 1) results.push(await reject(svc, payload()));
    expect(results[21].code).toBe('rate-limited');
  });

  it('a trade needing more gas than the cap, rather than clamping it (REGRESSION)', async () => {
    // Clamping sends a transaction that is guaranteed to run out of gas, and Monad bills the full
    // limit for it — the silent failure costs the most and explains the least.
    const svc = makeService();
    const internals = svc as unknown as {
      rpc: { readContract: jest.Mock; call: jest.Mock; estimateGas: jest.Mock };
    };
    internals.rpc.call = jest.fn(async () => ({ data: '0x' }));
    internals.rpc.estimateGas = jest.fn(async () => 1_000_000n); // x1.2 = 1.2M, over the 700k cap

    const err = await reject(svc, payload());
    expect(err.code).toBe('unavailable');
    expect(err.message).toMatch(/larger than the relayer is configured to sponsor/i);
    expect(err.message).toMatch(/nothing was spent/i);
  });

  it('everything when the relay is switched off (negative)', async () => {
    const svc = new RelayService(config({ enabled: false }), redis());
    const err = await reject(svc, payload());
    expect(err.code).toBe('unavailable');
  });

  it('a request the forwarder itself will not verify (negative)', async () => {
    // Signature, nonce, deadline: all checked by asking the contract rather than keeping a second
    // copy of its rules here, because two copies drift and the one on chain is the one that counts.
    const svc = makeService();
    (svc as unknown as { rpc: { readContract: jest.Mock } }).rpc.readContract = jest.fn(
      async () => false,
    );
    const err = await reject(svc, payload());
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/could not be verified/i);
  });
});

describe('what the relay does not require', () => {
  it('takes no session, token or user id (REGRESSION)', async () => {
    // The defining property. If a future change adds an identifier to this payload, our own logs
    // would hold the user↔account mapping the architecture exists to destroy — so the shape of the
    // request is itself a security assertion.
    expect(Object.keys(payload())).toEqual(['request']);
    expect(Object.keys(payload().request).sort()).toEqual([
      'data',
      'deadline',
      'from',
      'gas',
      'signature',
      'to',
      'value',
    ]);
  });
});

/**
 * The second relay: proposing and disputing an outcome.
 *
 * Same bargain as trading, same refusals, one different destination. The property worth pinning
 * hardest is that the two allowlists do not leak into each other — a trading selector must not be
 * relayable to the resolver, and a resolution selector must not be relayable to the engine. Either
 * direction would let somebody spend our gas on a call the corresponding forwarder would refuse.
 */

const RESOLVER = '0x4444444444444444444444444444444444444444';
const RESOLUTION_FORWARDER = '0x5555555555555555555555555555555555555555';

const RESOLVER_ABI = parseAbi([
  'function propose(address market, uint256 marketId, uint256 outcomeId)',
  'function dispute(address market, uint256 marketId, uint256 counterOutcomeId)',
  'function withdrawRewardPool(address to, uint256 amount)',
]);

const proposeData = encodeFunctionData({
  abi: RESOLVER_ABI,
  functionName: 'propose',
  args: [ENGINE, 1n, 0n],
});

function resolutionService(opts: { cfg?: AppConfigService } = {}) {
  const cfg =
    opts.cfg ??
    (() => {
      const base = config();
      (base.relay as unknown as Record<string, unknown>).resolutionForwarder =
        RESOLUTION_FORWARDER;
      (base.chain as unknown as { addresses: Record<string, unknown> }).addresses.optimisticResolver =
        RESOLVER;
      return base;
    })();

  const svc = makeService({ cfg });
  const internals = svc as unknown as {
    resolutionForwarder: string;
    resolutionResolver: string;
    resolutionSelectors: Set<string>;
  };
  internals.resolutionForwarder = RESOLUTION_FORWARDER;
  internals.resolutionResolver = RESOLVER;
  internals.resolutionSelectors = new Set(
    RESOLUTION_SIGNATURES.map((s) => toFunctionSelector(`function ${s}`)),
  );
  return svc;
}

function resolutionPayload(
  overrides: Partial<RelayRequestDto['request']> = {},
): RelayRequestDto {
  return {
    request: {
      from: ACCOUNT,
      to: RESOLVER,
      value: '0',
      gas: '350000',
      deadline: Math.floor(Date.now() / 1000) + 600,
      data: proposeData,
      signature: SIGNATURE,
      ...overrides,
    },
  };
}

async function rejectResolution(svc: RelayService, body: RelayRequestDto) {
  return svc.submitResolution(body).catch((e: unknown) => e) as Promise<RelayRejected>;
}

describe('the resolution relay refuses', () => {
  it('any destination but the resolver (REGRESSION)', async () => {
    const err = await rejectResolution(resolutionService(), resolutionPayload({ to: ENGINE }));
    expect(err).toBeInstanceOf(RelayRejected);
    expect(err.code).toBe('invalid');
  });

  /**
   * The cross-contamination case. `buy` is perfectly relayable — through the *other* forwarder, to
   * the *other* contract. Accepting it here would have us sponsor a call the resolution forwarder
   * would refuse on chain, so we would pay for a guaranteed revert.
   */
  it('a trading selector aimed at the resolver (REGRESSION)', async () => {
    const err = await rejectResolution(resolutionService(), resolutionPayload({ data: buyData }));
    expect(err).toBeInstanceOf(RelayRejected);
    expect(err.code).toBe('invalid');
  });

  it('and the trading relay refuses a resolution selector, in the other direction (REGRESSION)', async () => {
    const err = await reject(makeService(), payload({ data: proposeData }));
    expect(err).toBeInstanceOf(RelayRejected);
    expect(err.code).toBe('invalid');
  });

  /** Everything that moves money on the operator's authority is off the relayable list. */
  it('a call that would drain the reward pool', async () => {
    const data = encodeFunctionData({
      abi: RESOLVER_ABI,
      functionName: 'withdrawRewardPool',
      args: [ACCOUNT, 1_000_000n],
    });
    const err = await rejectResolution(resolutionService(), resolutionPayload({ data }));
    expect(err).toBeInstanceOf(RelayRejected);
    expect(err.code).toBe('invalid');
  });

  it('native value riding along with a proposal', async () => {
    const err = await rejectResolution(resolutionService(), resolutionPayload({ value: '1' }));
    expect(err).toBeInstanceOf(RelayRejected);
    expect(err.code).toBe('invalid');
  });

  it('a request asking for more gas than the relayer allows', async () => {
    const err = await rejectResolution(resolutionService(), resolutionPayload({ gas: '900000' }));
    expect(err).toBeInstanceOf(RelayRejected);
    expect(err.code).toBe('invalid');
  });

  /** A permit for somebody else bundled with your own proposal is "make them pay for my approval". */
  it('an approval that does not belong to the proposing account', async () => {
    const body = resolutionPayload();
    body.permit = {
      owner: '0x000000000000000000000000000000000000dEaD',
      value: '1',
      deadline: '9999999999',
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    };
    const err = await rejectResolution(resolutionService(), body);
    expect(err).toBeInstanceOf(RelayRejected);
    expect(err.code).toBe('invalid');
  });

  /**
   * Sponsored resolution failing must not take trading down with it. They are separate products,
   * and a trader with no relay cannot bet at all, whereas a proposer with no relay can still send
   * the transaction themselves and give up the privacy.
   */
  it('everything when it is not configured, without disabling trading (negative)', async () => {
    const svc = makeService(); // no resolution forwarder wired
    const err = await rejectResolution(svc, resolutionPayload());
    expect(err).toBeInstanceOf(RelayRejected);
    expect(err.code).toBe('unavailable');
    expect(svc.isEnabled).toBe(true);
    expect(svc.isResolutionEnabled).toBe(false);
  });

  it('reports itself available once wired', () => {
    expect(resolutionService().isResolutionEnabled).toBe(true);
  });
});

/**
 * What each audience is allowed to read.
 *
 * The public endpoint used to answer with the relayer's address, its balance, today's spend and the
 * cap, to anybody who asked. None of that is actionable by a trader; the balance is the weakest
 * signal this service holds — a drain shows up in the spend rate long before it shows up there —
 * and spend-against-cap is a live scoreboard for whoever is doing the draining.
 */
describe('the relay reports', () => {
  /** A service whose balance read answers, rather than one wired past a live RPC. */
  function withBalance(wei: bigint | null, cfg = config(), spentWei = 0n) {
    const svc = makeService({ cfg, redis: redis(spentWei) });
    (svc as unknown as { rpc: unknown }).rpc = {
      readContract: jest.fn(async () => true),
      getBalance: jest.fn(async () => {
        if (wei === null) throw new Error('rpc down');
        return wei;
      }),
    };
    return svc;
  }

  it('a state and no figures to the public (PRIVACY/SECURITY)', async () => {
    const state = await withBalance(10n * 10n ** 18n).publicState();

    expect(state).toEqual({ available: true, reason: null, resolution: false });
    // Named explicitly: a future field added to the gauge must not reach this shape by accident.
    expect(JSON.stringify(state)).not.toMatch(/0x|balance|wei|cap/i);
  });

  it('the whole gauge to an operator (positive)', async () => {
    const gauge = await withBalance(10n * 10n ** 18n).gauge();

    expect(gauge.balanceWei).toBe((10n * 10n ** 18n).toString());
    expect(gauge.dailyCapWei).toBe((50n * 10n ** 18n).toString());
    expect(gauge.minBalanceWei).toBe((2n * 10n ** 18n).toString());
    expect(gauge.lowBalance).toBe(false);
    expect(gauge.relayer).toMatch(/^0x/);
  });

  it('the cap as a refusal, since that one is enforced (positive)', async () => {
    const state = await withBalance(10n * 10n ** 18n, config(), 60n * 10n ** 18n).publicState();

    expect(state.available).toBe(false);
    expect(state.reason).toBe('capped');
  });

  it('a thin balance as nothing at all, in public (REGRESSION/SECURITY)', async () => {
    // Two MON is still tens of trades, so refusing there would be a self-inflicted outage — and
    // saying "running low" out loud confirms to whoever is draining us that it is working. The
    // operator gauge carries it instead.
    const svc = withBalance(1n * 10n ** 18n);

    await expect(svc.publicState()).resolves.toEqual({
      available: true,
      reason: null,
      resolution: false,
    });
    await expect(svc.gauge()).resolves.toMatchObject({ lowBalance: true });
  });

  it('an unreadable balance as unknown, not as empty (REGRESSION)', async () => {
    // An RPC that failed to answer must never present as a drained relayer, in either report.
    const svc = withBalance(null);

    await expect(svc.publicState()).resolves.toMatchObject({ available: true });
    await expect(svc.gauge()).resolves.toMatchObject({ balanceWei: null, lowBalance: false });
  });

  it('reads the balance once for a burst of callers (positive)', async () => {
    // Every open tab polls this. Without the cache each poll was its own `eth_getBalance`.
    const svc = withBalance(10n * 10n ** 18n);
    const getBalance = (svc as unknown as { rpc: { getBalance: jest.Mock } }).rpc.getBalance;

    await Promise.all([svc.gauge(), svc.gauge(), svc.gauge()]);

    expect(getBalance).toHaveBeenCalledTimes(1);
  });

  it('says disabled rather than available when there is no relayer (negative)', async () => {
    const svc = new RelayService(config({ enabled: false }), redis());

    await expect(svc.publicState()).resolves.toEqual({
      available: false,
      reason: 'disabled',
      resolution: false,
    });
  });
});

/**
 * A node that did not answer is not a contract that said no.
 *
 * These were reported identically: an unreachable RPC came back as "the contract rejected this
 * request", a 400, and therefore something no client retries. It is the wrong party, the wrong
 * advice, and the wrong status — and it cost two debugging sessions chasing a revert that had
 * never happened.
 */
describe('RelayService — a failed simulation is not always a refusal', () => {
  const transport = () => new Error('RPC Request failed.');
  // A genuine revert always carries revert data somewhere in its cause chain; a transport failure
  // never does, which is what the two are told apart by.
  const revert = () => Object.assign(new Error('execution reverted'), { cause: { data: '0xd6bda275' } });

  function serviceThatFailsSimulation(makeError: () => Error) {
    const svc = makeService();
    const internals = svc as unknown as {
      rpc: { call: jest.Mock; estimateGas: jest.Mock };
    };
    internals.rpc.call = jest.fn(async () => {
      throw makeError();
    });
    internals.rpc.estimateGas = jest.fn(async () => {
      throw makeError();
    });
    return svc;
  }

  it('treats an unreachable node as temporary, so the caller retries', async () => {
    const svc = serviceThatFailsSimulation(transport);

    const err = await svc
      .sendFromRelayer(ENGINE as `0x${string}`, '0x1234', 'probe')
      .then(() => null, (e: RelayRejected) => e);

    expect(err?.code).toBe('unavailable');
    expect(err?.message).toMatch(/network did not answer/i);
  });

  it('still reports a real revert as a refusal (positive)', async () => {
    const svc = serviceThatFailsSimulation(revert);

    const err = await svc
      .sendFromRelayer(ENGINE as `0x${string}`, '0x1234', 'probe')
      .then(() => null, (e: RelayRejected) => e);

    expect(err?.code).toBe('rejected');
    expect(err?.message).toMatch(/contract rejected/i);
  });

  it('does the same for a relayed trade, which had the identical flaw', async () => {
    const svc = serviceThatFailsSimulation(transport);

    const err = await reject(svc, payload());

    expect(err.code).toBe('unavailable');
    expect(err.message).toMatch(/network did not answer/i);
  });
});
