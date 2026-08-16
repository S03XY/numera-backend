import { ResolutionPhase } from '@prisma/client';
import { decodeFunctionData, parseAbi } from 'viem';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { RelayService } from './relay.service';
import { SettlementService } from './settlement.service';

/**
 * The keeper that pays the winners.
 *
 * A proposal nobody challenged is not settled — the engine has heard nothing, and every claim
 * against it reverts — until `finalize` lands. That gap is what these tests are about, and the
 * failure they guard against already happened once: a market sat unclaimable with a winner
 * watching it, because "anyone can finalize" turned out to mean nobody did.
 */

const RESOLVER = '0xf64540780f6ab79ed91d6d76536a981899ed7215';
const ENGINE = '0x801003b4a85a01e921d044dcca9c39eb3c10d3c4';

const FINALIZE = parseAbi(['function finalize(address market, uint256 marketId)']);

function config(overrides: { enabled?: boolean; resolver?: string | null } = {}) {
  return {
    settlement: { enabled: overrides.enabled ?? true, pollIntervalMs: 20_000 },
    chain: {
      addresses: {
        optimisticResolver: overrides.resolver === undefined ? RESOLVER : overrides.resolver,
      },
    },
  } as unknown as AppConfigService;
}

interface Row {
  address: string;
  marketId: bigint;
  marketRef: string | null;
}

function prisma(rows: Row[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  return {
    service: { resolutionProposal: { findMany } } as unknown as PrismaService,
    findMany,
  };
}

function relay(send: jest.Mock, enabled = true) {
  return {
    isEnabled: enabled,
    sendFromRelayer: send,
    receiptFor: jest.fn().mockResolvedValue({ status: 'success' }),
  } as unknown as RelayService;
}

/** One pass of the loop, without waiting out the poll interval. */
function pass(service: SettlementService): Promise<void> {
  return (service as unknown as { tick(): Promise<void> }).tick();
}

const row = (marketId: bigint): Row => ({ address: ENGINE, marketId, marketRef: null });

describe('SettlementService', () => {
  it('finalizes a proposal whose window has passed', async () => {
    const send = jest.fn().mockResolvedValue(`0x${'ab'.repeat(32)}`);
    const db = prisma([row(8n)]);
    const service = new SettlementService(config(), db.service, relay(send));

    await pass(service);

    expect(send).toHaveBeenCalledTimes(1);
    const [to, data] = send.mock.calls[0] as [string, `0x${string}`, string];
    expect(to).toBe(RESOLVER);
    // The engine is an *argument*, not the destination: `finalize` lives on the resolver and takes
    // the market it is settling. Swapping the two produces a call to a contract that has no such
    // function, which fails as a revert rather than as anything legible.
    const call = decodeFunctionData({ abi: FINALIZE, data });
    expect(call.functionName).toBe('finalize');
    // Lowercased on both sides: the indexer stores addresses lowercase and viem decodes to the
    // checksummed form, so a raw comparison fails on capitalisation and says nothing about wiring.
    expect(call.args[0].toLowerCase()).toBe(ENGINE);
    expect(call.args[1]).toBe(8n);
  });

  it('asks only for proposals that are past their deadline and still open', async () => {
    const db = prisma([]);
    const service = new SettlementService(config(), db.service, relay(jest.fn()));

    await pass(service);

    const where = db.findMany.mock.calls[0][0].where;
    expect(where.phase).toBe(ResolutionPhase.PROPOSED);
    expect(where.disputeDeadline.lt).toBeInstanceOf(Date);
    // A disputed proposal is the quorum's to settle and a settled one is done. Sending `finalize`
    // at either reverts, which costs a simulation and says nothing useful in the log.
    expect(where.disputeDeadline.not).toBeNull();
  });

  it('does not send a second time while the first is still landing', async () => {
    const send = jest.fn().mockResolvedValue(`0x${'ab'.repeat(32)}`);
    const db = prisma([row(8n)]);
    const service = new SettlementService(config(), db.service, relay(send));

    // The row stays `PROPOSED` in the database until the indexer catches up, so the next pass sees
    // exactly what this one did. Sending again would double-spend gas on a call that now reverts.
    await pass(service);
    await pass(service);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('backs off after a failure rather than retrying every tick', async () => {
    const send = jest.fn().mockRejectedValue(new Error('reverted'));
    const db = prisma([row(8n)]);
    const service = new SettlementService(config(), db.service, relay(send));

    await pass(service);
    await pass(service);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('survives a failure and keeps settling the rest of the batch', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('reverted'))
      .mockResolvedValue(`0x${'ab'.repeat(32)}`);
    const db = prisma([row(8n), row(9n)]);
    const service = new SettlementService(config(), db.service, relay(send));

    await pass(service);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends nothing while the relay is down', async () => {
    const send = jest.fn();
    const db = prisma([row(8n)]);
    const service = new SettlementService(config(), db.service, relay(send, false));

    await pass(service);

    // Not an error state. `finalize` stays permissionless on chain, so a relay outage delays
    // settlement rather than stranding it.
    expect(send).not.toHaveBeenCalled();
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it('sends nothing when no resolver is configured', async () => {
    const send = jest.fn();
    const db = prisma([row(8n)]);
    const service = new SettlementService(config({ resolver: null }), db.service, relay(send));

    await pass(service);

    expect(send).not.toHaveBeenCalled();
  });

  it('never starts when settlement is switched off', () => {
    const db = prisma([row(8n)]);
    const service = new SettlementService(config({ enabled: false }), db.service, relay(jest.fn()));

    service.onModuleInit();
    expect((service as unknown as { timer: unknown }).timer).toBeNull();
  });
});
