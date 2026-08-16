import { UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuthService } from './auth.service';
import { AuthTokensService } from './auth-tokens.service';
import { SiweService } from './siwe.service';

const ADDR = '0x52908400098527886e0f7030069857d2e4169ee7';

const cfg = {
  auth: { nonceTtlSeconds: 300 },
} as unknown as AppConfigService;

const tokenPair = {
  accessToken: 'access',
  refreshToken: 'refresh',
  accessExpiresIn: '900s',
  refreshExpiresIn: '30d',
};

function setup() {
  const siwe = {
    prepare: jest.fn(() => ({ message: 'msg', nonce: 'nonce-123', expiresAt: new Date() })),
    verify: jest.fn(async () => ({ ok: true, address: ADDR, nonce: 'nonce-123' })),
  } as unknown as SiweService;

  const tokens = {
    issue: jest.fn(async () => tokenPair),
    rotate: jest.fn(async () => ({ tokens: tokenPair, userId: 'u1', address: ADDR })),
    revoke: jest.fn(async () => undefined),
  } as unknown as AuthTokensService;

  const prisma = {
    user: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'u1', address: ADDR, displayName: null })),
      update: jest.fn(async () => ({ id: 'u1', address: ADDR, displayName: null })),
    },
  } as unknown as PrismaService;

  const redis = {
    client: { set: jest.fn(async () => 'OK'), get: jest.fn(async () => 'nonce-123') },
    del: jest.fn(async () => undefined),
  } as unknown as RedisService;

  const svc = new AuthService(siwe, tokens, prisma, redis, cfg);
  return { svc, siwe, tokens, prisma, redis };
}

describe('AuthService', () => {
  it('requestNonce stores a nonce and returns the message (positive)', async () => {
    const { svc, redis } = setup();
    const res = await svc.requestNonce(ADDR);
    expect(res.message).toBe('msg');
    expect(res.nonce).toBe('nonce-123');
    expect(redis.client.set).toHaveBeenCalledWith(`auth:nonce:${ADDR}`, 'nonce-123', 'EX', 300);
  });

  it('verify signs up a new user on first login (positive)', async () => {
    const { svc, prisma } = setup();
    const res = await svc.verify('msg', '0xsig', {});
    expect(res.isNewUser).toBe(true);
    expect(prisma.user.create).toHaveBeenCalled();
    expect(res.tokens).toEqual(tokenPair);
  });

  it('verify logs in an existing user without signup (positive)', async () => {
    const { svc, prisma } = setup();
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'u1',
      address: ADDR,
      displayName: 'x',
    });
    const res = await svc.verify('msg', '0xsig', {});
    expect(res.isNewUser).toBe(false);
    expect(prisma.user.update).toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('verify rejects a bad signature (negative)', async () => {
    const { svc, siwe } = setup();
    (siwe.verify as jest.Mock).mockResolvedValueOnce({ ok: false, reason: 'invalid signature' });
    await expect(svc.verify('msg', '0xbad', {})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('verify rejects a stale/mismatched nonce (negative)', async () => {
    const { svc, redis } = setup();
    (redis.client.get as jest.Mock).mockResolvedValueOnce('a-different-nonce');
    await expect(svc.verify('msg', '0xsig', {})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('verify rejects when the nonce is missing/expired (negative)', async () => {
    const { svc, redis } = setup();
    (redis.client.get as jest.Mock).mockResolvedValueOnce(null);
    await expect(svc.verify('msg', '0xsig', {})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refresh delegates to token rotation (positive)', async () => {
    const { svc, tokens } = setup();
    const res = await svc.refresh('refresh', {});
    expect(res).toEqual(tokenPair);
    expect(tokens.rotate).toHaveBeenCalled();
  });
});
