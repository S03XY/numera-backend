import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ChainService } from '../chain/chain.service';
import { RedisService } from '../redis/redis.service';
import { ProtocolRole, ProtocolRoleName, ROLE_SOURCE, RoleContractGroup } from './roles';

const CACHE_TTL_SECONDS = 30; // short: a revoked role must stop working quickly

/**
 * Resolves what an address is allowed to do by reading **on-chain AccessControl**.
 *
 * There is deliberately no admin/role table in our database: the contracts are
 * the single source of truth, so granting or revoking a role on-chain takes
 * effect here within {@link CACHE_TTL_SECONDS} with no migration or sync step.
 * Results are cached briefly in Redis so the admin UI stays fast without
 * hammering the RPC.
 */
@Injectable()
export class AdminAccessService {
  private readonly logger = new Logger(AdminAccessService.name);

  constructor(
    private readonly cfg: AppConfigService,
    private readonly chain: ChainService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Development escape hatch: when the chain is not configured, an explicit
   * ADMIN_ADDRESSES allowlist stands in for on-chain roles. Never active in
   * production, and never active when an RPC is available.
   */
  private get devAllowlist(): string[] {
    return this.cfg.admin.devAddresses;
  }

  private contractsFor(group: RoleContractGroup): `0x${string}`[] {
    const a = this.cfg.chain.addresses;
    const engines = [a.lsLmsr];
    // Both, in this order. The trusted resolver is what markets are bound to, but the roles an
    // operator actually holds — bond-free proposing, arbitration — live on the optimistic layer.
    const resolvers = [a.optimisticResolver, a.trustedResolver];
    const factory = [a.factory];
    const blocklist = [a.blocklist];
    const pick =
      group === 'engines'
        ? engines
        : group === 'resolvers'
          ? resolvers
          : group === 'factory'
            ? factory
            : group === 'blocklist'
              ? blocklist
              : [...engines, ...resolvers, ...factory, ...blocklist];
    return pick.filter((x): x is `0x${string}` => x !== null);
  }

  /** True if `address` holds `role` on any contract that can grant it. */
  async hasRole(address: string, role: ProtocolRoleName): Promise<boolean> {
    const account = address.toLowerCase() as `0x${string}`;

    if (!this.chain.isReady) {
      const allowed = this.devAllowlist.includes(account);
      if (allowed) {
        this.logger.warn(
          `dev allowlist granted ${role} to ${account} (no chain configured) — do not use in production`,
        );
      }
      return allowed;
    }

    const cacheKey = `admin:role:${role}:${account}`;
    const cached = await this.redis.getJson<boolean>(cacheKey);
    if (cached !== null) return cached;

    const contracts = this.contractsFor(ROLE_SOURCE[role]);
    let granted = false;
    for (const contract of contracts) {
      try {
        if (await this.chain.hasRole(contract, ProtocolRole[role], account)) {
          granted = true;
          break;
        }
        // DEFAULT_ADMIN on any contract implies full operator authority there.
        if (
          role !== 'DEFAULT_ADMIN' &&
          (await this.chain.hasRole(contract, ProtocolRole.DEFAULT_ADMIN, account))
        ) {
          granted = true;
          break;
        }
      } catch (err) {
        this.logger.warn(`hasRole read failed on ${contract}: ${(err as Error).message}`);
      }
    }

    await this.redis.setJson(cacheKey, granted, CACHE_TTL_SECONDS);
    return granted;
  }

  /** True if the address holds any one of the listed roles. */
  async hasAnyRole(address: string, roles: ProtocolRoleName[]): Promise<boolean> {
    for (const role of roles) {
      if (await this.hasRole(address, role)) return true;
    }
    return false;
  }

  /** Every role the address currently holds — drives the admin UI's navigation. */
  async rolesOf(address: string): Promise<ProtocolRoleName[]> {
    const names = Object.keys(ProtocolRole) as ProtocolRoleName[];
    const held = await Promise.all(
      names.map(async (r) => ((await this.hasRole(address, r)) ? r : null)),
    );
    return held.filter((r): r is ProtocolRoleName => r !== null);
  }
}
