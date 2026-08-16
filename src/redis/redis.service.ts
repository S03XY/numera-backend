import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT, REDIS_PUBLISHER, REDIS_SUBSCRIBER } from './redis.constants';

/**
 * Cache + pub/sub facade over ioredis.
 *
 * - `client`     — general commands and the JSON cache helpers below.
 * - `publisher`  — dedicated connection for PUBLISH (also used by the WS adapter).
 * - `subscriber` — dedicated connection for SUBSCRIBE (a subscribed connection
 *                  cannot run normal commands, hence the split).
 */
@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private readonly handlers = new Map<string, Set<(msg: string) => void>>();
  private readonly patternHandlers = new Map<string, Set<(channel: string, msg: string) => void>>();

  constructor(
    @Inject(REDIS_CLIENT) public readonly client: Redis,
    @Inject(REDIS_PUBLISHER) public readonly publisher: Redis,
    @Inject(REDIS_SUBSCRIBER) public readonly subscriber: Redis,
  ) {
    this.subscriber.on('message', (channel: string, message: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      for (const h of set) {
        try {
          h(message);
        } catch (err) {
          this.logger.error(`subscriber handler for ${channel} threw`, err as Error);
        }
      }
    });
    this.subscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
      const set = this.patternHandlers.get(pattern);
      if (!set) return;
      for (const h of set) {
        try {
          h(channel, message);
        } catch (err) {
          this.logger.error(`psubscribe handler for ${pattern} threw`, err as Error);
        }
      }
    });
  }

  // ---------------------------------------------------------------- cache ----

  /** Read + JSON.parse a key. Returns null on miss or parse failure. */
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** JSON.stringify + write a key with an optional TTL (seconds). */
  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(key, raw, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, raw);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys);
  }

  /**
   * Cache-aside helper: return the cached value or compute, store (with TTL),
   * and return it. `factory` only runs on a miss.
   */
  async wrap<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.getJson<T>(key);
    if (cached !== null) return cached;
    const fresh = await factory();
    await this.setJson(key, fresh, ttlSeconds);
    return fresh;
  }

  /** Delete every key matching a glob pattern (uses SCAN, non-blocking). */
  async delPattern(pattern: string): Promise<void> {
    const stream = this.client.scanStream({ match: pattern, count: 200 });
    const batch: string[] = [];
    for await (const keys of stream as AsyncIterable<string[]>) {
      batch.push(...keys);
      if (batch.length >= 500) {
        await this.client.del(...batch.splice(0));
      }
    }
    if (batch.length) await this.client.del(...batch);
  }

  // --------------------------------------------------------------- pub/sub ---

  async publish(channel: string, message: unknown): Promise<void> {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    await this.publisher.publish(channel, payload);
  }

  /** Subscribe a handler to a channel. Returns an unsubscribe function. */
  async subscribe(channel: string, handler: (msg: string) => void): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(handler);
    return async () => {
      set!.delete(handler);
      if (set!.size === 0) {
        this.handlers.delete(channel);
        await this.subscriber.unsubscribe(channel);
      }
    };
  }

  /** Pattern-subscribe (PSUBSCRIBE). Handler receives (channel, message). */
  async pSubscribe(
    pattern: string,
    handler: (channel: string, msg: string) => void,
  ): Promise<() => Promise<void>> {
    let set = this.patternHandlers.get(pattern);
    if (!set) {
      set = new Set();
      this.patternHandlers.set(pattern, set);
      await this.subscriber.psubscribe(pattern);
    }
    set.add(handler);
    return async () => {
      set!.delete(handler);
      if (set!.size === 0) {
        this.patternHandlers.delete(pattern);
        await this.subscriber.punsubscribe(pattern);
      }
    };
  }
}
