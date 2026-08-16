/** DI tokens for the dedicated Redis connections. */
export const REDIS_CLIENT = 'REDIS_CLIENT'; // general commands + cache
export const REDIS_PUBLISHER = 'REDIS_PUBLISHER'; // pub/sub publish + WS adapter
export const REDIS_SUBSCRIBER = 'REDIS_SUBSCRIBER'; // pub/sub subscribe + WS adapter
