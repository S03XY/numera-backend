import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { UsersModule } from './users/users.module';
import { MarketsModule } from './markets/markets.module';
import { TradesModule } from './trades/trades.module';
import { PositionsModule } from './positions/positions.module';
import { PricesModule } from './prices/prices.module';
import { ChainModule } from './chain/chain.module';
import { RealtimeModule } from './realtime/realtime.module';
import { AdminModule } from './admin/admin.module';
import { UnlinkModule } from './unlink/unlink.module';
import { RelayModule } from './relay/relay.module';
import { PoolModule } from './pool/pool.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    AppConfigModule,
    // Structured, fast JSON logging (pretty-printed in dev).
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => ({
        pinoHttp: {
          level: cfg.app.logLevel,
          transport: cfg.isProduction ? undefined : { target: 'pino-pretty' },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          autoLogging: cfg.isTest
            ? false
            : {
                // The gas relay takes a signature and no session, specifically so that nothing
                // here can record which user owns which market account. Request logging would
                // reinstate exactly that: the caller's IP, timestamped, moments before a public
                // transaction naming the account. Neither half is sensitive alone; the pair is the
                // whole thing this design exists to prevent, and it would be sitting in our own
                // logs. `RelayService` still logs the account, which is public on chain anyway.
                ignore: (req: { url?: string }) => (req.url ?? '').startsWith('/api/relay'),
              },
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => ({
        throttlers: [{ ttl: cfg.throttle.ttlSeconds * 1000, limit: cfg.throttle.limit }],
      }),
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    UsersModule,
    MarketsModule,
    TradesModule,
    PositionsModule,
    PricesModule,
    ChainModule,
    RealtimeModule,
    AdminModule,
    UnlinkModule,
    RelayModule,
    PoolModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
