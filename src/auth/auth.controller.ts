import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { RefreshDto, RequestNonceDto, VerifySignatureDto } from './dto/auth.dto';

function meta(req: Request) {
  return {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('nonce')
  @HttpCode(200)
  // Tighter limit on nonce issuance to blunt spam.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request a nonce + SIWE message to sign (step 1).' })
  requestNonce(@Body() dto: RequestNonceDto) {
    return this.auth.requestNonce(dto.address);
  }

  @Public()
  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Verify a signed SIWE message (step 2). First time = signup; returns tokens.',
  })
  verify(@Body() dto: VerifySignatureDto, @Req() req: Request) {
    return this.auth.verify(dto.message, dto.signature, meta(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair — returning login, no signature needed.',
  })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, meta(req));
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke a refresh session.' })
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
    return { ok: true };
  }
}
