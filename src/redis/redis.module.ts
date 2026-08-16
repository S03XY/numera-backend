import { Global, Logger, Module, OnApplicationShutdown, Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { REDIS_CLIENT, REDIS_PUBLISHER, REDIS_SUBSCRIBER } from './redis.constants';
import { RedisService } from './redis.service';

function makeClient(cfg: AppConfigService, role: string): Redis {
  const { host, port, password, db } = cfg.redis;
  const client = new Redis({
    host,
    port,
    password,
    db,
    lazyConnect: false,
    maxRetriesPerRequest: null, // keep retrying rather than throwing on blips
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    connectionName: `pm-${role}`,
  });
  const logger = new Logger(`Redis:${role}`);
  client.on('error', (err) => logger.error(`redis error: ${err.message}`));
  client.on('connect', () => logger.log('connected'));
  return client;
}

const clientProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (cfg: AppConfigService) => makeClient(cfg, 'client'),
  inject: [AppConfigService],
};
const publisherProvider: Provider = {
  provide: REDIS_PUBLISHER,
  useFactory: (cfg: AppConfigService) => makeClient(cfg, 'pub'),
  inject: [AppConfigService],
};
const subscriberProvider: Provider = {
  provide: REDIS_SUBSCRIBER,
  useFactory: (cfg: AppConfigService) => makeClient(cfg, 'sub'),
  inject: [AppConfigService],
};

@Global()
@Module({
  providers: [clientProvider, publisherProvider, subscriberProvider, RedisService],
  exports: [RedisService, REDIS_CLIENT, REDIS_PUBLISHER, REDIS_SUBSCRIBER],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(private readonly redis: RedisService) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      this.redis.client.quit(),
      this.redis.publisher.quit(),
      this.redis.subscriber.quit(),
    ]);
  }
}
