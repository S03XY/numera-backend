import { Injectable, Logger } from '@nestjs/common';
import { PoolLeafKind } from '@prisma/client';
import { encodeFunctionData } from 'viem';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChainService } from '../chain/chain.service';
import { RelayService } from '../relay/relay.service';
import { POOL_ENTRYPOINT_ABI, PRIVACY_POOL_ABI, PUB_SIGNAL } from './pool.abi';
import { aspRootHistory, buildAspTree, type PoolLeafRow } from './pool.tree';
import type { PoolShieldDto, PoolWithdrawDto } from './dto/pool.dto';
import { PoolIndexerService } from './pool-indexer.service';

/** A refusal the caller can act on, carried to the controller as a status plus renderable copy. */
export class PoolRejected extends Error {
  constructor(
    readonly kind: 'unavailable' | 'invalid' | 'stale' | 'rejected',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PoolRejected';
  }
}

/** A row as Prisma returns it, narrowed to what this service reads. */
type PoolLeafRecord = PoolLeafRow & {
  value: string;
  precommitment: string | null;
  spentNullifier: string | null;
};

/** One leaf as the browser receives it. Every field is already public on chain. */
export interface PoolLeafView {
  index: number;
  kind: PoolLeafKind;
  commitment: string;
  label: string | null;
  value: string;
  precommitment: string | null;
  spentNullifier: string | null;
}

export interface PoolStateView {
  enabled: boolean;
  chainId: number;
  entrypoint: string;
  privacyPool: string;
  asset: string;
  scope: string;
  /** The pool's own root. The browser rebuilds the tree and must agree with this. */
  stateRoot: string;
  /** What the entrypoint currently accepts. */
  onChainAspRoot: string;
  /** What we would publish next, from the deposits we have indexed. */
  aspRoot: string;
  synced: boolean;
  leaves: PoolLeafView[];
}

/**
 * Numera's shielded pool, from the backend's side of it.
 *
 * ## What this service is not
 *
 * It is not custody, and it holds no secret belonging to anybody. Everything it stores is already
 * on chain; everything it sends was signed elsewhere. A complete compromise of this process lets an
 * attacker waste our gas and publish stale association roots — an availability problem — and does
 * not let them move one unit of anyone's collateral. That bound is the reason the pool is worth
 * having, and every design choice below defers to it.
 *
 * ## The three jobs
 *
 *  1. **Serve the state tree.** A withdrawal proof needs a Merkle path through every leaf the pool
 *     has ever inserted. Assembling that in a browser means crawling from the deployment block at a
 *     hundred blocks per request, which on Monad is thousands of round trips. {@link state} makes it
 *     one GET, and returns the chain's own root alongside so the browser can check its rebuild
 *     rather than trust us.
 *  2. **Keep the association root current, and correct.** See {@link publishAspRoot}.
 *  3. **Pay for other people's transactions**, without learning who they are.
 */
@Injectable()
export class PoolService {
  private readonly log = new Logger(PoolService.name);

  /**
   * Serialises the (publish root, relay proof) pair.
   *
   * `RelayService` already serialises *transactions* on one nonce queue, which is not the same
   * thing. Two withdrawals interleaving as publish(A), publish(B), relay(A), relay(B) would send
   * all four in a valid nonce order and fail the third: A's proof pins root A and the chain now
   * holds B. The pair has to be atomic with respect to other withdrawals, so it takes a lock of its
   * own. Held across two transactions, which is the reason it is a promise chain and not a flag.
   */
  private lock: Promise<unknown> = Promise.resolve();

  /** `SCOPE()` never changes for a deployed pool, so it is read once. */
  private cachedScope: bigint | null = null;

  constructor(
    private readonly cfg: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    private readonly relay: RelayService,
    private readonly indexer: PoolIndexerService,
  ) {}

  get isEnabled(): boolean {
    return this.cfg.pool.enabled && this.chain.isReady;
  }

  // ------------------------------------------------------------------ reads

  /**
   * Every leaf, in the order the tree was built.
   *
   * Ordered by `(blockNumber, logIndex)` and never by `id`. Insertion order into this table is a
   * function of when the indexer happened to run; the tree's order is a fact about the chain, and
   * an append-only tree built in the wrong order has a root that matches nothing.
   */
  private leaves(): Promise<PoolLeafRecord[]> {
    return this.prisma.poolLeaf.findMany({
      orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }],
    });
  }

  async state(): Promise<PoolStateView> {
    if (!this.isEnabled) {
      return {
        enabled: false,
        chainId: this.cfg.chain.chainId,
        entrypoint: '',
        privacyPool: '',
        asset: '',
        scope: '0',
        stateRoot: '0',
        onChainAspRoot: '0',
        aspRoot: '0',
        synced: false,
        leaves: [],
      };
    }

    const rows = await this.leaves();
    const [scope, stateRoot, onChainAspRoot] = await Promise.all([
      this.scope(),
      this.readPool('currentRoot'),
      this.readEntrypoint('latestRoot'),
    ]);

    return {
      enabled: true,
      chainId: this.cfg.chain.chainId,
      entrypoint: this.cfg.pool.entrypoint ?? '',
      privacyPool: this.cfg.pool.privacyPool ?? '',
      asset: this.cfg.chain.addresses.usdc ?? '',
      scope: scope.toString(),
      stateRoot: stateRoot.toString(),
      onChainAspRoot: onChainAspRoot.toString(),
      aspRoot: buildAspTree(rows).root?.toString() ?? '0',
      /*
        Reported rather than enforced. A browser that builds a tree from an incomplete mirror gets a
        root the chain has never held, and the failure surfaces much later as an `UnknownStateRoot`
        revert on a proof that took thirty seconds to generate. Saying "still catching up" here lets
        the client wait instead, which is the difference between a spinner and a mystery.
      */
      synced: this.indexer.isSynced,
      leaves: rows.map((row, index) => ({
        index,
        kind: row.kind,
        commitment: row.commitment,
        label: row.label,
        value: row.value,
        precommitment: row.precommitment,
        spentNullifier: row.spentNullifier,
      })),
    };
  }

  // ------------------------------------------------------------------ writes

  /**
   * Submit a withdrawal proof, publishing the association root it was built against first.
   *
   * The pool demands `proof.ASPRoot == entrypoint.latestRoot()` exactly, at execution time. Since
   * the set advances with every deposit and proving takes seconds, the root a browser proved against
   * is routinely not the one on chain by the time its proof arrives.
   *
   * So the root follows the proof rather than the other way round: we accept any root in our own
   * recent history, republish it, and relay. Replaying an old association root sounds alarming and
   * is not — every root in that history is one we computed from deposits we indexed, and an older
   * set is a strictly smaller one. Nothing gets approved that was not approved before.
   *
   * What we refuse is a root we do not recognise, which is the case that would matter: it would mean
   * proving membership of an association set somebody else chose.
   */
  async withdraw(dto: PoolWithdrawDto): Promise<{ hash: string }> {
    if (!this.isEnabled) {
      throw new PoolRejected('unavailable', 'Private withdrawals are not available here.');
    }
    if (!this.indexer.isSynced) {
      throw new PoolRejected(
        'stale',
        'The pool index is still catching up. Nothing was sent — try again in a moment.',
      );
    }

    const entrypoint = this.cfg.pool.entrypoint as `0x${string}`;
    const withdrawal = dto.withdrawal;

    if (withdrawal.processooor.toLowerCase() !== entrypoint.toLowerCase()) {
      // The pool pays whoever it is told is processing, and only the entrypoint forwards onward.
      // A different processooor is a payout to somewhere that will never hand it over.
      throw new PoolRejected('invalid', 'A withdrawal must be processed by the pool entrypoint.');
    }

    const signals = dto.proof.pubSignals.map((s) => BigInt(s));
    const provedAspRoot = signals[PUB_SIGNAL.aspRoot];

    const rows = await this.leaves();
    const known = aspRootHistory(rows);
    if (!known.includes(provedAspRoot)) {
      throw new PoolRejected(
        'stale',
        'This proof was built against an association set we do not recognise. Refresh and try again.',
      );
    }

    const proof = {
      pA: [BigInt(dto.proof.pA[0]), BigInt(dto.proof.pA[1])] as [bigint, bigint],
      pB: [
        [BigInt(dto.proof.pB[0][0]), BigInt(dto.proof.pB[0][1])],
        [BigInt(dto.proof.pB[1][0]), BigInt(dto.proof.pB[1][1])],
      ] as [[bigint, bigint], [bigint, bigint]],
      pC: [BigInt(dto.proof.pC[0]), BigInt(dto.proof.pC[1])] as [bigint, bigint],
      pubSignals: signals as unknown as readonly bigint[],
    };

    return this.exclusively(async () => {
      await this.publishAspRoot(provedAspRoot);

      const data = encodeFunctionData({
        abi: POOL_ENTRYPOINT_ABI,
        functionName: 'relay',
        args: [
          { processooor: entrypoint, data: withdrawal.data as `0x${string}` },
          proof as never,
        ],
      });

      const hash = await this.relay
        .sendFromRelayer(entrypoint, data, 'pool withdrawal')
        .catch((err) => {
          throw new PoolRejected(
            'rejected',
            'That withdrawal could not be submitted. Nothing was sent and nothing was spent.',
            err,
          );
        });

      // Value and recipient are deliberately absent. Both are in the calldata anyway, and a log
      // line pairing them with a timestamp is the join this pool exists to prevent — ours would be
      // the easiest copy of it to subpoena.
      this.log.log(`relayed a shielded withdrawal — ${hash}`);
      return { hash };
    });
  }

  /**
   * Make `entrypoint.latestRoot()` equal `root`, or do nothing if it already is.
   *
   * Called with the lock held. The no-op case is the common one once a pool is quiet, and skipping
   * it matters: `updateRoot` reverts on an unchanged root by design, so publishing unconditionally
   * would fail every second withdrawal.
   */
  private async publishAspRoot(root: bigint): Promise<void> {
    const current = await this.readEntrypoint('latestRoot');
    if (current === root) return;

    const data = encodeFunctionData({
      abi: POOL_ENTRYPOINT_ABI,
      functionName: 'updateRoot',
      args: [root],
    });
    const hash = await this.relay.sendFromRelayer(
      this.cfg.pool.entrypoint as `0x${string}`,
      data,
      'ASP root',
    );

    /*
      Awaited, and this is the whole reason the two calls are ordered rather than merely queued.

      `sendFromRelayer` returns once a transaction is *broadcast*, not once it is mined — correct for
      everything else, because the nonce queue already guarantees ordering on chain. It is wrong
      here, because the very next thing that happens is a *simulation* of the withdrawal, and a
      simulation runs against the chain as it is now. With the root still unpublished, the pool
      re-derives `IncorrectASPRoot`, the relay refuses to broadcast, and the trader is told their
      withdrawal was rejected by the contract — for a condition that was about to stop being true.

      Nonce ordering does not help: it guarantees the two land in order, and the simulation happens
      before either does.
    */
    const receipt = await this.relay.receiptFor(hash);
    if (receipt?.status !== 'success') {
      throw new PoolRejected(
        'stale',
        'The association set could not be published. Nothing was sent — try again in a moment.',
      );
    }
    this.log.log(`published association root ${root}`);
  }

  /**
   * Return a gasless account's balance to the pool on its behalf.
   *
   * The account signed an EIP-712 `Shield` naming the note, so this endpoint can be open: a
   * submitter who altered anything — the amount, the precommitment, the owner — would produce a
   * signature that recovers to nobody. We are paying for the transaction, which is the only thing
   * being granted here, and the relay's own daily cap bounds that.
   */
  async shield(dto: PoolShieldDto): Promise<{ hash: string }> {
    if (!this.isEnabled) {
      throw new PoolRejected('unavailable', 'Private deposits are not available here.');
    }

    const entrypoint = this.cfg.pool.entrypoint as `0x${string}`;
    const request = {
      owner: dto.request.owner as `0x${string}`,
      value: BigInt(dto.request.value),
      precommitment: BigInt(dto.request.precommitment),
      deadline: BigInt(dto.request.deadline),
    };
    if (request.value === 0n) {
      throw new PoolRejected('invalid', 'There is nothing to return to the pool.');
    }
    if (request.deadline * 1000n < BigInt(Date.now())) {
      throw new PoolRejected('invalid', 'This instruction has expired. Sign a fresh one.');
    }

    const data = dto.permit
      ? encodeFunctionData({
          abi: POOL_ENTRYPOINT_ABI,
          functionName: 'depositForWithPermit',
          args: [
            request,
            dto.signature as `0x${string}`,
            BigInt(dto.permit.deadline),
            dto.permit.v,
            dto.permit.r as `0x${string}`,
            dto.permit.s as `0x${string}`,
          ],
        })
      : encodeFunctionData({
          abi: POOL_ENTRYPOINT_ABI,
          functionName: 'depositFor',
          args: [request, dto.signature as `0x${string}`],
        });

    const hash = await this.relay
      .sendFromRelayer(entrypoint, data, 'shielded return')
      .catch((err) => {
        throw new PoolRejected(
          'rejected',
          'That deposit could not be submitted. Nothing was sent and nothing was spent.',
          err,
        );
      });

    this.log.log(`relayed a shielded return — ${hash}`);
    return { hash };
  }

  // ------------------------------------------------------------------ plumbing

  private exclusively<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    // Swallow on the chain itself so one failure does not poison every later caller; the original
    // rejection still reaches whoever asked for it.
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async scope(): Promise<bigint> {
    if (this.cachedScope === null) this.cachedScope = await this.readPool('SCOPE');
    return this.cachedScope;
  }

  private readPool(fn: 'SCOPE' | 'currentRoot' | 'currentTreeSize'): Promise<bigint> {
    return this.chain.readUint(this.cfg.pool.privacyPool as `0x${string}`, PRIVACY_POOL_ABI, fn);
  }

  private readEntrypoint(fn: 'latestRoot' | 'rootIndex' | 'scope'): Promise<bigint> {
    return this.chain.readUint(this.cfg.pool.entrypoint as `0x${string}`, POOL_ENTRYPOINT_ABI, fn);
  }
}
