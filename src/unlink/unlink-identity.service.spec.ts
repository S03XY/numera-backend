import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UnlinkIdentityService } from './unlink-identity.service';

const USER = 'user-1';
const ADDR = 'unlink1aaa';
const OTHER = 'unlink1bbb';

function makeService(current: string | null, updateImpl?: jest.Mock) {
  const update = updateImpl ?? jest.fn(async () => ({}));
  const prisma = {
    user: {
      findUnique: jest.fn(async () => (current === undefined ? null : { unlinkAddress: current })),
      update,
    },
  } as unknown as PrismaService;
  return { svc: new UnlinkIdentityService(prisma), prisma, update };
}

describe('UnlinkIdentityService.bind', () => {
  it('binds an address to an unbound user (positive)', async () => {
    const { svc, update } = makeService(null);
    await svc.bind(USER, ADDR);
    expect(update).toHaveBeenCalledWith({ where: { id: USER }, data: { unlinkAddress: ADDR } });
  });

  it('is idempotent when re-binding the same address (positive)', async () => {
    // Clients re-register freely — Engine's registration is idempotent, so ours must be too.
    const { svc, update } = makeService(ADDR);
    await svc.bind(USER, ADDR);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses to repoint a user at a different address (negative)', async () => {
    // Identity is derived deterministically; a change means a different passkey or
    // changed appId/chainId. Silently repointing would strand unclaimed winnings.
    const { svc, update } = makeService(ADDR);
    await expect(svc.bind(USER, OTHER)).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it('surfaces a unique-constraint clash as a conflict, not a 500 (negative)', async () => {
    const update = jest.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      });
    });
    const { svc } = makeService(null, update);
    await expect(svc.bind(USER, ADDR)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rethrows unexpected database errors unchanged (negative)', async () => {
    const boom = new Error('connection lost');
    const update = jest.fn(async () => {
      throw boom;
    });
    const { svc } = makeService(null, update);
    await expect(svc.bind(USER, ADDR)).rejects.toBe(boom);
  });
});

describe('UnlinkIdentityService.owns', () => {
  it('confirms ownership of a bound address (positive)', async () => {
    const { svc } = makeService(ADDR);
    await expect(svc.owns(USER, ADDR)).resolves.toBe(true);
  });

  it('denies a different address (negative)', async () => {
    const { svc } = makeService(ADDR);
    await expect(svc.owns(USER, OTHER)).resolves.toBe(false);
  });

  it('denies when the user has no bound address (negative)', async () => {
    const { svc } = makeService(null);
    await expect(svc.owns(USER, ADDR)).resolves.toBe(false);
  });

  it('never matches on a null-vs-null comparison (regression)', async () => {
    // A user with no address must not "own" a null address by accident.
    const { svc } = makeService(null);
    await expect(svc.owns(USER, null as unknown as string)).resolves.toBe(false);
  });
});
