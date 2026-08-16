import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminAccessService } from '../admin-access.service';
import type { ProtocolRoleName } from '../roles';

export const PROTOCOL_ROLES_KEY = 'protocolRoles';

/**
 * Restricts a route to holders of one of the given on-chain roles.
 * Runs after the global JwtAuthGuard, so the caller's wallet is already proven.
 */
export const RequiresRole = (...roles: ProtocolRoleName[]) =>
  SetMetadata(PROTOCOL_ROLES_KEY, roles);

@Injectable()
export class ProtocolRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AdminAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<ProtocolRoleName[]>(PROTOCOL_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const address = req.user?.address;
    if (!address) throw new ForbiddenException('authentication required');

    const allowed = await this.access.hasAnyRole(address, roles);
    if (!allowed) {
      throw new ForbiddenException(
        `wallet ${address} does not hold any of the required on-chain roles: ${roles.join(', ')}`,
      );
    }
    return true;
  }
}
