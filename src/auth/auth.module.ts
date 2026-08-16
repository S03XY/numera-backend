import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthTokensService } from './auth-tokens.service';
import { SiweService } from './siwe.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule,
    // Secrets/expiry are passed per-sign call (two secrets), so register bare.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthTokensService, SiweService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
