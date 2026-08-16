import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

// This key's address is the one listed in ADMIN_DEV_ADDRESSES for local dev.
const OPERATOR_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// A second wallet that holds no role.
const OUTSIDER_PK = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

const operator = privateKeyToAccount(OPERATOR_PK);
const outsider = privateKeyToAccount(OUTSIDER_PK);

async function login(app: INestApplication, account: typeof operator): Promise<string> {
  const server = app.getHttpServer();
  const nonce = await request(server)
    .post('/api/auth/nonce')
    .send({ address: account.address })
    .expect(200);
  const signature = await account.signMessage({ message: nonce.body.message });
  const verified = await request(server)
    .post('/api/auth/verify')
    .send({ message: nonce.body.message, signature })
    .expect(200);
  return verified.body.tokens.accessToken;
}

describe('Admin (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let operatorToken: string;
  let outsiderToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    operatorToken = await login(app, operator);
    outsiderToken = await login(app, outsider);
  });

  afterAll(async () => {
    await prisma.marketMetadataDraft.deleteMany({ where: { createdBy: operator.address.toLowerCase() } });
    await prisma.user.deleteMany({
      where: { address: { in: [operator.address.toLowerCase(), outsider.address.toLowerCase()] } },
    });
    await app.close();
  });

  // ---- authorization ------------------------------------------------------

  it('rejects an unauthenticated admin request (negative)', async () => {
    await request(app.getHttpServer()).get('/api/admin/operations').expect(401);
  });

  it('rejects an authenticated wallet with no on-chain role (negative)', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/operations')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .expect(403);
  });

  it('rejects a non-operator trying to draft a market (negative)', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/markets/drafts')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ title: 'Sneaky market', outcomeLabels: ['Yes', 'No'] })
      .expect(403);
  });

  it('reports the operator roles for an authorized wallet (positive)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    expect(res.body.address).toBe(operator.address.toLowerCase());
    expect(res.body.isOperator).toBe(true);
  });

  // ---- metadata draft flow ------------------------------------------------

  it('drafts market metadata and returns a deterministic metadataHash (positive)', async () => {
    const body = {
      title: 'E2E: World Cup Final',
      description: 'Full-time result',
      outcomeLabels: ['Argentina', 'Draw', 'France'],
      categoryKey: 'SPORTS',
    };
    const first = await request(app.getHttpServer())
      .post('/api/admin/markets/drafts')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send(body)
      .expect(201);

    expect(first.body.metadataHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Idempotent: same content -> same hash, no duplicate row.
    const second = await request(app.getHttpServer())
      .post('/api/admin/markets/drafts')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send(body)
      .expect(201);
    expect(second.body.metadataHash).toBe(first.body.metadataHash);

    const drafts = await request(app.getHttpServer())
      .get('/api/admin/markets/drafts')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    const found = drafts.body.filter((d: { metadataHash: string }) => d.metadataHash === first.body.metadataHash);
    expect(found).toHaveLength(1);
    expect(found[0].adopted).toBe(false);
  });

  it('rejects a draft with too few outcomes (negative, validation)', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/markets/drafts')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ title: 'Bad market', outcomeLabels: ['OnlyOne'] })
      .expect(400);
  });

  it('rejects a draft with an unknown extra field (negative, whitelist)', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/markets/drafts')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ title: 'Market', outcomeLabels: ['Yes', 'No'], feeBps: 9999 })
      .expect(400);
  });

  // ---- operations queue ---------------------------------------------------

  it('returns the operations queue for an operator (positive)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/operations')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    expect(res.body).toHaveProperty('awaitingResolution');
    expect(res.body).toHaveProperty('readyToFinalize');
    expect(res.body).toHaveProperty('awaitingArbitration');
    expect(res.body.counts).toBeDefined();
  });

  it('reports treasury as unavailable when no chain is configured', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/treasury')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    expect(res.body.available).toBe(false);
  });
});
