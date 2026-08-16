import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthTokensService } from './auth-tokens.service';

const cfg = {
  auth: {
    accessSecret: 'a'.repeat(24),
    refreshSecret: 'b'.repeat(24),
    accessTtl: '900s',
    refreshTtl: '30d',
  },
} as unknown as AppConfigService;

/** In-memory refresh_sessions store standing in for Prisma. */
function makeFakePrisma(users: Record<string, string>) {
  const sessions = new Map<string, any>();
  return {
    sessions,
    refreshSession: {
      create: jest.fn(async ({ data }: any) => {
        sessions.set(data.id, { ...data, revokedAt: null });
        return data;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const s = sessions.get(where.id);
        if (!s) return null;
        return { ...s, user: { address: users[s.userId] } };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const s = sessions.get(where.id);
        Object.assign(s, data);
        return s;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        for (const s of sessions.values()) {
          if (s.userId === where.userId && s.revokedAt == null) Object.assign(s, data);
        }
        return { count: 0 };
      }),
    },
  } as unknown as PrismaService & { sessions: Map<string, any> };
}

describe('AuthTokensService', () => {
  const jwt = new JwtService({});

  it('issues a token pair and persists a session (positive)', async () => {
    const prisma = makeFakePrisma({ 'user-1': '0xabc' });
    const svc = new AuthTokensService(jwt, cfg, prisma);

    const pair = await svc.issue('user-1', '0xabc', { userAgent: 'jest', ip: '127.0.0.1' });

    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();
    expect((prisma as any).sessions.size).toBe(1);

    const decoded = await jwt.verifyAsync(pair.accessToken, { secret: cfg.auth.accessSecret });
    expect(decoded.sub).toBe('user-1');
    expect(decoded.type).toBe('access');
  });

  it('rotates a valid refresh token into a new pair (positive)', async () => {
    const prisma = makeFakePrisma({ 'user-1': '0xabc' });
    const svc = new AuthTokensService(jwt, cfg, prisma);
    const first = await svc.issue('user-1', '0xabc', {});

    const { tokens, userId } = await svc.rotate(first.refreshToken, {});
    expect(userId).toBe('user-1');
    expect(tokens.refreshToken).not.toBe(first.refreshToken);
    expect((prisma as any).sessions.size).toBe(2); // old + new
  });

  it('detects reuse of a rotated refresh token and revokes all (negative)', async () => {
    const prisma = makeFakePrisma({ 'user-1': '0xabc' });
    const svc = new AuthTokensService(jwt, cfg, prisma);
    const first = await svc.issue('user-1', '0xabc', {});
    await svc.rotate(first.refreshToken, {}); // consumes `first`

    await expect(svc.rotate(first.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshSession.updateMany).toHaveBeenCalled(); // revoke-all triggered
  });

  it('rejects a garbage refresh token (negative)', async () => {
    const prisma = makeFakePrisma({});
    const svc = new AuthTokensService(jwt, cfg, prisma);
    await expect(svc.rotate('not.a.jwt', {})).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
