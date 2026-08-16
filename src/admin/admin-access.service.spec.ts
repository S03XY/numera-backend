import { AppConfigService } from '../config/app-config.service';
import { ChainService } from '../chain/chain.service';
import { RedisService } from '../redis/redis.service';
import { AdminAccessService } from './admin-access.service';
import { ProtocolRole } from './roles';

const LMSR = '0x1111111111111111111111111111111111111111';
const FACTORY = '0x2222222222222222222222222222222222222222';
const RESOLVER = '0x3333333333333333333333333333333333333333';
const USER = '0xaaaa111111111111111111111111111111111111';

function makeCfg(devAddresses: string[] = []): AppConfigService {
  return {
    chain: {
      addresses: {
        lmsr: LMSR,
        parimutuel: null,
        factory: FACTORY,
        trustedResolver: RESOLVER,
        usdc: null,
      },
    },
    admin: { devAddresses },
  } as unknown as AppConfigService;
}

function makeRedis() {
  const store = new Map<string, unknown>();
  return {
    getJson: jest.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    setJson: jest.fn(async (k: string, v: unknown) => void store.set(k, v)),
  } as unknown as RedisService;
}

describe('AdminAccessService', () => {
  it('grants a role when the contract says hasRole (positive)', async () => {
    const chain = {
      isReady: true,
      hasRole: jest.fn(async (_c: string, role: string) => role === ProtocolRole.MARKET_CREATOR),
    } as unknown as ChainService;
    const svc = new AdminAccessService(makeCfg(), chain, makeRedis());

    expect(await svc.hasRole(USER, 'MARKET_CREATOR')).toBe(true);
  });

  it('denies a role the wallet does not hold (negative)', async () => {
    const chain = {
      isReady: true,
      hasRole: jest.fn(async () => false),
    } as unknown as ChainService;
    const svc = new AdminAccessService(makeCfg(), chain, makeRedis());

    expect(await svc.hasRole(USER, 'FEE_MANAGER')).toBe(false);
  });

  it('treats DEFAULT_ADMIN on a contract as implying other roles (positive)', async () => {
    const chain = {
      isReady: true,
      hasRole: jest.fn(async (_c: string, role: string) => role === ProtocolRole.DEFAULT_ADMIN),
    } as unknown as ChainService;
    const svc = new AdminAccessService(makeCfg(), chain, makeRedis());

    expect(await svc.hasRole(USER, 'MARKET_CREATOR')).toBe(true);
  });

  it('checks the right contract group per role (CURATOR -> factory)', async () => {
    const hasRole = jest.fn(async () => false) as jest.Mock;
    const chain = { isReady: true, hasRole } as unknown as ChainService;
    const svc = new AdminAccessService(makeCfg(), chain, makeRedis());

    await svc.hasRole(USER, 'CURATOR');
    const contractsQueried = hasRole.mock.calls.map((c) => c[0]);
    expect(contractsQueried).toContain(FACTORY);
    expect(contractsQueried).not.toContain(LMSR);
  });

  it('caches the result so repeat checks do not re-hit the RPC (positive)', async () => {
    const hasRole = jest.fn(async () => true);
    const chain = { isReady: true, hasRole } as unknown as ChainService;
    const svc = new AdminAccessService(makeCfg(), chain, makeRedis());

    await svc.hasRole(USER, 'MARKET_CREATOR');
    const callsAfterFirst = hasRole.mock.calls.length;
    await svc.hasRole(USER, 'MARKET_CREATOR');
    expect(hasRole.mock.calls.length).toBe(callsAfterFirst); // served from cache
  });

  it('survives an RPC failure by denying rather than throwing (negative)', async () => {
    const chain = {
      isReady: true,
      hasRole: jest.fn(async () => {
        throw new Error('rpc down');
      }),
    } as unknown as ChainService;
    const svc = new AdminAccessService(makeCfg(), chain, makeRedis());

    await expect(svc.hasRole(USER, 'MARKET_CREATOR')).resolves.toBe(false);
  });

  it('falls back to the dev allowlist only when no chain is configured', async () => {
    const chain = { isReady: false, hasRole: jest.fn() } as unknown as ChainService;
    const svc = new AdminAccessService(makeCfg([USER]), chain, makeRedis());

    expect(await svc.hasRole(USER, 'MARKET_CREATOR')).toBe(true);
    expect(await svc.hasRole('0xbbbb111111111111111111111111111111111111', 'MARKET_CREATOR')).toBe(
      false,
    );
  });

  it('ignores the dev allowlist once a chain IS configured (negative — no bypass)', async () => {
    const chain = {
      isReady: true,
      hasRole: jest.fn(async () => false),
    } as unknown as ChainService;
    const svc = new AdminAccessService(makeCfg([USER]), chain, makeRedis());

    expect(await svc.hasRole(USER, 'MARKET_CREATOR')).toBe(false);
  });

  it('rolesOf returns every held role', async () => {
    const chain = {
      isReady: true,
      hasRole: jest.fn(
        async (_c: string, role: string) =>
          role === ProtocolRole.CURATOR || role === ProtocolRole.PAUSER,
      ),
    } as unknown as ChainService;
    const svc = new AdminAccessService(makeCfg(), chain, makeRedis());

    const roles = await svc.rolesOf(USER);
    expect(roles).toEqual(expect.arrayContaining(['CURATOR', 'PAUSER']));
    expect(roles).not.toContain('DEFAULT_ADMIN');
  });
});
