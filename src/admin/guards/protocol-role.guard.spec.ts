import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminAccessService } from '../admin-access.service';
import { ProtocolRoleGuard } from './protocol-role.guard';

function ctx(user?: { userId: string; address: string }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function makeGuard(requiredRoles: string[] | undefined, granted: boolean) {
  const reflector = { getAllAndOverride: jest.fn(() => requiredRoles) } as unknown as Reflector;
  const access = { hasAnyRole: jest.fn(async () => granted) } as unknown as AdminAccessService;
  return { guard: new ProtocolRoleGuard(reflector, access), access };
}

describe('ProtocolRoleGuard', () => {
  it('allows a wallet holding a required role (positive)', async () => {
    const { guard } = makeGuard(['MARKET_CREATOR'], true);
    await expect(
      guard.canActivate(ctx({ userId: 'u1', address: '0xabc' })),
    ).resolves.toBe(true);
  });

  it('rejects a wallet without the role (negative)', async () => {
    const { guard } = makeGuard(['FEE_MANAGER'], false);
    await expect(guard.canActivate(ctx({ userId: 'u1', address: '0xabc' }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects an unauthenticated request (negative)', async () => {
    const { guard } = makeGuard(['CURATOR'], true);
    await expect(guard.canActivate(ctx(undefined))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('passes through routes with no role requirement', async () => {
    const { guard, access } = makeGuard(undefined, false);
    await expect(guard.canActivate(ctx({ userId: 'u1', address: '0xabc' }))).resolves.toBe(true);
    expect(access.hasAnyRole).not.toHaveBeenCalled();
  });

  it('checks all listed roles (any-of semantics)', async () => {
    const { guard, access } = makeGuard(['MARKET_CREATOR', 'CURATOR'], true);
    await guard.canActivate(ctx({ userId: 'u1', address: '0xABC' }));
    expect(access.hasAnyRole).toHaveBeenCalledWith('0xABC', ['MARKET_CREATOR', 'CURATOR']);
  });
});
