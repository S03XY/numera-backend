import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

export interface AccessPayload {
  sub: string; // userId
  addr: string; // wallet address
  type: 'access';
}

interface RefreshPayload {
  sub: string; // userId
  jti: string; // session id
  type: 'refresh';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: string;
  refreshExpiresIn: string;
}

/** sha256 of a token; only the hash is ever stored server-side. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues and rotates the access/refresh token pair and manages the persisted
 * refresh-session records that back the "returning user, no re-signature" flow.
 */
@Injectable()
export class AuthTokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly cfg: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Mint a new pair and persist the refresh session (rotation start). */
  async issue(
    userId: string,
    address: string,
    meta: { userAgent?: string; ip?: string },
  ): Promise<TokenPair> {
    const jti = randomUUID();
    const { accessTtl, refreshTtl } = this.cfg.auth;

    const accessToken = await this.jwt.signAsync(
      { sub: userId, addr: address, type: 'access' } satisfies AccessPayload,
      this.signOpts(this.cfg.auth.accessSecret, accessTtl),
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, jti, type: 'refresh' } satisfies RefreshPayload,
      this.signOpts(this.cfg.auth.refreshSecret, refreshTtl),
    );

    await this.prisma.refreshSession.create({
      data: {
        id: jti,
        userId,
        tokenHash: hashToken(refreshToken),
        userAgent: meta.userAgent?.slice(0, 512),
        ip: meta.ip,
        expiresAt: this.refreshExpiry(),
      },
    });

    return {
      accessToken,
      refreshToken,
      accessExpiresIn: accessTtl,
      refreshExpiresIn: refreshTtl,
    };
  }

  /**
   * Verify a refresh token, ensure its session is live, then rotate: the old
   * session is revoked and a fresh pair issued. Reuse of a rotated (already
   * revoked) token is rejected — basic refresh-token-reuse detection.
   */
  async rotate(
    refreshToken: string,
    meta: { userAgent?: string; ip?: string },
  ): Promise<{ tokens: TokenPair; userId: string; address: string }> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.cfg.auth.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('invalid or expired refresh token');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('wrong token type');
    }

    const session = await this.prisma.refreshSession.findUnique({
      where: { id: payload.jti },
      include: { user: true },
    });
    if (!session || session.tokenHash !== hashToken(refreshToken)) {
      throw new UnauthorizedException('unknown session');
    }
    if (session.revokedAt) {
      // Token reuse after rotation: revoke every session for the user as a precaution.
      await this.revokeAllForUser(session.userId);
      throw new UnauthorizedException('refresh token already used');
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('session expired');
    }

    // Revoke the presented session and mint a new one (rotation).
    await this.prisma.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    const tokens = await this.issue(session.userId, session.user.address, meta);
    return { tokens, userId: session.userId, address: session.user.address };
  }

  /** Revoke a single session by its refresh token (logout). */
  async revoke(refreshToken: string): Promise<void> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.cfg.auth.refreshSecret,
      });
    } catch {
      return; // already invalid — nothing to revoke
    }
    await this.prisma.refreshSession.updateMany({
      where: { id: payload.jti, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** jsonwebtoken types `expiresIn` as a branded string; our config carries a
   *  plain string ("30d"), which is valid at runtime — cast to the option type. */
  private signOpts(secret: string, expiresIn: string): JwtSignOptions {
    return { secret, expiresIn: expiresIn as unknown as number };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.ttlToMs(this.cfg.auth.refreshTtl));
  }

  /** Parse a jsonwebtoken-style TTL ("30d", "900s", "12h", or raw seconds). */
  private ttlToMs(ttl: string): number {
    const m = /^(\d+)\s*(s|m|h|d)?$/.exec(ttl.trim());
    if (!m) return 0;
    const n = Number(m[1]);
    switch (m[2]) {
      case 'd':
        return n * 86_400_000;
      case 'h':
        return n * 3_600_000;
      case 'm':
        return n * 60_000;
      case 's':
      case undefined:
      default:
        return n * 1000;
    }
  }
}
