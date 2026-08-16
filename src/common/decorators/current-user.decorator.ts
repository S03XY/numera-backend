import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** The authenticated principal attached to the request by the JWT strategy. */
export interface AuthUser {
  userId: string;
  address: string;
}

/** Injects the authenticated user (or a specific field of it) into a handler. */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, ctx: ExecutionContext): AuthUser | string | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (!req.user) return undefined;
    return field ? req.user[field] : req.user;
  },
);
