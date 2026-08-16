/**
 * Single source of truth for realtime channel + event names, shared by the
 * indexer (which publishes to Redis) and the WebSocket gateway (which relays to
 * subscribed clients). Redis channels and Socket.IO rooms are kept 1:1 so the
 * gateway can bridge them mechanically.
 */
export const RealtimeEvent = {
  Trade: 'trade',
  Price: 'price',
  MarketStatus: 'market_status',
  MarketCreated: 'market_created',
  /**
   * A market moved through the resolution layer: proposed, disputed, settled, or unwound.
   *
   * Separate from {@link MarketStatus} because the two answer different questions. Status is "can
   * I claim yet"; this is "what is happening to the outcome right now", and it changes several
   * times while status stays `TRADING`.
   */
  Resolution: 'resolution',
} as const;
export type RealtimeEventName = (typeof RealtimeEvent)[keyof typeof RealtimeEvent];

const PREFIX = 'rt';

/** Redis pub/sub channel for a per-market event stream. */
export function marketChannel(marketRef: string, event: RealtimeEventName): string {
  return `${PREFIX}:market:${marketRef}:${event}`;
}

/** Redis pub/sub channel for global (non-market-scoped) events. */
export function globalChannel(event: RealtimeEventName): string {
  return `${PREFIX}:global:${event}`;
}

/** Socket.IO room a client joins to receive a market's stream. */
export function marketRoom(marketRef: string): string {
  return `market:${marketRef}`;
}

/** Socket.IO room for global events (new markets, etc.). */
export const GLOBAL_ROOM = 'global';

/** Wildcard pattern the gateway subscribes to for bridging market channels. */
export const MARKET_CHANNEL_PATTERN = `${PREFIX}:market:*`;
export const GLOBAL_CHANNEL_PATTERN = `${PREFIX}:global:*`;

/** Envelope every realtime message is wrapped in before it hits the wire. */
export interface RealtimeMessage<T = unknown> {
  event: RealtimeEventName;
  marketRef?: string;
  data: T;
  ts: number;
}
