import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { RedisService } from '../redis/redis.service';
import {
  GLOBAL_CHANNEL_PATTERN,
  GLOBAL_ROOM,
  MARKET_CHANNEL_PATTERN,
  marketRoom,
} from '../common/constants/realtime';

/**
 * Public realtime gateway. Clients join per-market rooms and receive live
 * `trade` / `price` / `market_status` / `resolution` events plus a global
 * `market_created` feed.
 *
 * Fan-out design: the indexer PUBLISHes domain events to Redis; every backend
 * instance PSUBSCRIBEs and emits ONLY to its locally-connected room members.
 * Since each client is connected to exactly one instance, this scales
 * horizontally with no duplication and without the socket.io redis-adapter.
 */
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  transports: ['websocket'],
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private unsubscribers: Array<() => Promise<void>> = [];

  @WebSocketServer()
  private server!: Server;

  constructor(private readonly redis: RedisService) {}

  async afterInit(): Promise<void> {
    const bridge = (channel: string, message: string) => this.relay(channel, message);
    this.unsubscribers.push(await this.redis.pSubscribe(MARKET_CHANNEL_PATTERN, bridge));
    this.unsubscribers.push(await this.redis.pSubscribe(GLOBAL_CHANNEL_PATTERN, bridge));
    this.logger.log('realtime gateway bridging Redis channels to socket rooms');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(this.unsubscribers.map((u) => u()));
  }

  handleConnection(client: Socket): void {
    this.logger.debug(`ws connect ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`ws disconnect ${client.id}`);
  }

  @SubscribeMessage('subscribe')
  onSubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { marketRef?: string }) {
    if (!body?.marketRef || !isUuid(body.marketRef)) {
      return { ok: false, error: 'marketRef (uuid) required' };
    }
    void client.join(marketRoom(body.marketRef));
    return { ok: true, room: marketRoom(body.marketRef) };
  }

  @SubscribeMessage('unsubscribe')
  onUnsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { marketRef?: string }) {
    if (body?.marketRef) void client.leave(marketRoom(body.marketRef));
    return { ok: true };
  }

  @SubscribeMessage('subscribeGlobal')
  onSubscribeGlobal(@ConnectedSocket() client: Socket) {
    void client.join(GLOBAL_ROOM);
    return { ok: true, room: GLOBAL_ROOM };
  }

  @SubscribeMessage('ping')
  onPing() {
    return { event: 'pong', ts: Date.now() };
  }

  /** Redis channel -> socket room. Emits the event name parsed from the channel. */
  private relay(channel: string, message: string): void {
    const parsed = parseChannel(channel);
    if (!parsed) return;
    let payload: unknown;
    try {
      payload = JSON.parse(message);
    } catch {
      payload = message;
    }
    this.server.to(parsed.room).emit(parsed.event, payload);
  }
}

function parseChannel(channel: string): { room: string; event: string } | null {
  const parts = channel.split(':'); // rt:market:<ref>:<event> | rt:global:<event>
  if (parts[0] !== 'rt') return null;
  if (parts[1] === 'market' && parts.length >= 4) {
    return { room: marketRoom(parts[2]), event: parts.slice(3).join(':') };
  }
  if (parts[1] === 'global' && parts.length >= 3) {
    return { room: GLOBAL_ROOM, event: parts.slice(2).join(':') };
  }
  return null;
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
