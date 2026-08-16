import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { normalizeAddress, checksumAddress } from '../common/utils/address';
import { SiweService } from './siwe.service';
import { AuthTokensService, TokenPair } from './auth-tokens.service';

interface RequestMeta {
  userAgent?: string;
  ip?: string;
}

export interface AuthResult {
  isNewUser: boolean;
  user: { id: string; address: string; displayName: string | null };
  tokens: TokenPair;
}

/**
 * Wallet-only authentication.
 *
 *  - Nonce  : `POST /auth/nonce` issues a single-use, address-bound nonce
 *             (stored in Redis with a TTL) and a ready-to-sign SIWE message.
 *  - Verify : `POST /auth/verify` checks the signature + nonce, upserts the
 *             user (first time = signup), and returns an access+refresh pair.
 *  - Refresh: `POST /auth/refresh` swaps a valid refresh token for a new pair
 *             with NO new signature — this is the "just connect wallet" return
 *             login. Only when the refresh session expires/revokes must the
 *             user sign again.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly siwe: SiweService,
    private readonly tokens: AuthTokensService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly cfg: AppConfigService,
  ) {}

  private nonceKey(address: string): string {
    return `auth:nonce:${address}`;
  }

  /** Step 1 — issue a nonce + SIWE message for the wallet to sign. */
  async requestNonce(rawAddress: string): Promise<{ message: string; nonce: string; expiresAt: string }> {
    const address = normalizeAddress(rawAddress);
    const prepared = this.siwe.prepare(checksumAddress(address));
    // Bind the nonce to the address, single-use, auto-expiring.
    await this.redis.client.set(
      this.nonceKey(address),
      prepared.nonce,
      'EX',
      this.cfg.auth.nonceTtlSeconds,
    );
    return {
      message: prepared.message,
      nonce: prepared.nonce,
      expiresAt: prepared.expiresAt.toISOString(),
    };
  }

  /** Step 2 — verify the signature, upsert the user, and issue tokens. */
  async verify(message: string, signature: string, meta: RequestMeta): Promise<AuthResult> {
    const result = await this.siwe.verify(message, signature as `0x${string}`);
    if (!result.ok || !result.address || !result.nonce) {
      throw new UnauthorizedException(`signature verification failed: ${result.reason ?? 'unknown'}`);
    }
    const address = result.address; // already lowercased

    // Single-use nonce check: must match what we issued for THIS address.
    const stored = await this.redis.client.get(this.nonceKey(address));
    if (!stored || stored !== result.nonce) {
      throw new UnauthorizedException('nonce invalid, expired, or already used');
    }
    await this.redis.del(this.nonceKey(address)); // consume it

    const existing = await this.prisma.user.findUnique({ where: { address } });
    const isNewUser = !existing;

    const user = existing
      ? await this.prisma.user.update({
          where: { address },
          data: { lastLoginAt: new Date() },
        })
      : await this.prisma.user.create({ data: { address } });

    const tokens = await this.tokens.issue(user.id, user.address, meta);
    this.logger.log(`${isNewUser ? 'signup' : 'login'} ${address}`);

    return {
      isNewUser,
      user: { id: user.id, address: user.address, displayName: user.displayName },
      tokens,
    };
  }

  /** Step 3 — returning login with no signature: rotate the refresh token. */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<TokenPair> {
    const { tokens } = await this.tokens.rotate(refreshToken, meta);
    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revoke(refreshToken);
  }
}
