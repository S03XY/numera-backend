import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(PK);

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await prisma.user.deleteMany({ where: { address: account.address.toLowerCase() } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { address: account.address.toLowerCase() } });
    await app.close();
  });

  it('full wallet flow: nonce -> sign -> verify (signup) -> me -> refresh', async () => {
    const server = app.getHttpServer();

    // 1. nonce
    const nonceRes = await request(server)
      .post('/api/auth/nonce')
      .send({ address: account.address })
      .expect(200);
    expect(nonceRes.body.message).toContain('Sign in');

    // 2. sign + verify (first time == signup)
    const signature = await account.signMessage({ message: nonceRes.body.message });
    const verifyRes = await request(server)
      .post('/api/auth/verify')
      .send({ message: nonceRes.body.message, signature })
      .expect(200);
    expect(verifyRes.body.isNewUser).toBe(true);
    expect(verifyRes.body.user.address).toBe(account.address.toLowerCase());
    const { accessToken, refreshToken } = verifyRes.body.tokens;
    expect(accessToken).toBeTruthy();

    // 3. authenticated /me
    const meRes = await request(server)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(meRes.body.address).toBe(account.address.toLowerCase());

    // 4. refresh (returning login — no new signature)
    const refreshRes = await request(server)
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    expect(refreshRes.body.accessToken).toBeTruthy();
    expect(refreshRes.body.refreshToken).not.toBe(refreshToken);
  });

  it('second login for the same wallet is not a signup', async () => {
    const server = app.getHttpServer();
    const nonceRes = await request(server)
      .post('/api/auth/nonce')
      .send({ address: account.address })
      .expect(200);
    const signature = await account.signMessage({ message: nonceRes.body.message });
    const verifyRes = await request(server)
      .post('/api/auth/verify')
      .send({ message: nonceRes.body.message, signature })
      .expect(200);
    expect(verifyRes.body.isNewUser).toBe(false);
  });

  it('rejects a bad signature (negative)', async () => {
    const server = app.getHttpServer();
    const nonceRes = await request(server)
      .post('/api/auth/nonce')
      .send({ address: account.address })
      .expect(200);
    await request(server)
      .post('/api/auth/verify')
      .send({ message: nonceRes.body.message, signature: '0x' + '00'.repeat(65) })
      .expect(401);
  });

  it('rejects access to a protected route without a token (negative)', async () => {
    await request(app.getHttpServer()).get('/api/users/me').expect(401);
  });

  it('rejects a malformed address on nonce (negative, validation)', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/nonce')
      .send({ address: 'not-an-address' })
      .expect(400);
  });
});
