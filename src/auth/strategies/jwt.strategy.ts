import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfigService } from '../../config/app-config.service';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import type { AccessPayload } from '../auth-tokens.service';

/** Validates the access JWT and shapes the request principal. */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(cfg: AppConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: cfg.auth.accessSecret,
    });
  }

  validate(payload: AccessPayload): AuthUser {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('wrong token type');
    }
    return { userId: payload.sub, address: payload.addr };
  }
}
