import { parseAbi } from 'viem';

/**
 * Human-readable ABIs for the events and view calls the indexer needs.
 */

/**
 * The damped LS-LMSR engine. One engine hosts every market, so unlike the
 * retired multi-engine setup there is a single event ABI to decode against.
 *
 * `Shorted` is the position `buyComplement` opens: it credits one share of every
 * outcome EXCEPT `outcomeId`, so it pays 1 per share exactly when that outcome
 * loses. The indexer must fan it out across the other outcomes rather than
 * recording it against `outcomeId`, which is the one place a naive reading of
 * this event would silently invert every short position.
 */
export const LS_LMSR_EVENTS = parseAbi([
  'event MarketCreated(uint256 indexed marketId, address indexed collateral, address indexed creator, address resolver, uint32 outcomeCount, uint64 startTime, uint64 closeTime, uint256 alpha, uint256 sStar, uint256 seedPerOutcome, uint256 seedCost, bytes32 category, bytes32 metadataHash)',
  /**
   * The canonical metadata a market committed to, in full, once.
   *
   * The engine checks `keccak256(metadata) == metadataHash` before emitting, and has no function
   * that can supersede it. So this log — not our database — is the authority on what a market
   * promised, and indexing it is what lets anyone verify that the copy we serve is the copy that
   * was committed to.
   */
  'event MarketMetadataPublished(uint256 indexed marketId, bytes32 indexed metadataHash, string metadata)',
  'event Bought(uint256 indexed marketId, address indexed account, uint256 indexed outcomeId, uint256 shares, uint256 cost, uint256 spreadWad)',
  'event Shorted(uint256 indexed marketId, address indexed account, uint256 indexed outcomeId, uint256 shares, uint256 cost, uint256 spreadWad)',
  'event Sold(uint256 indexed marketId, address indexed account, uint256 indexed outcomeId, uint256 shares, uint256 proceeds, uint256 spreadWad)',
  'event MarketResolved(uint256 indexed marketId, uint32 winningOutcomeId, uint256 owed, uint256 surplus)',
  'event MarketInvalidated(uint256 indexed marketId, uint256 surplus)',
  'event Redeemed(uint256 indexed marketId, address indexed account, uint256 amount)',
  'event SeedRedeemed(uint256 indexed marketId, address indexed creator, uint256 amount)',
]);


/**
 * The bonded resolution layer.
 *
 * PRIVACY: `proposer`, `disputer`, `winner` and `account` in these events are **market execution
 * accounts**, not login wallets — proposals arrive relayed from the same shielded account that
 * placed the bets. Anything the indexer stores from them is subject to the same rule as trades:
 * never joined to a user.
 *
 * Note that `market` here is the *engine* address, while the log's own address is the resolver's.
 * A handler that keys off `log.address` instead of `args.market` will look up the wrong market and
 * silently find nothing, which is the one mistake this decoding invites.
 */
export const OPTIMISTIC_RESOLVER_EVENTS = parseAbi([
  'event Proposed(address indexed market, uint256 indexed marketId, address indexed proposer, uint256 outcome, uint256 bond, uint256 fee, bool bonded, uint64 disputeDeadline)',
  'event Disputed(address indexed market, uint256 indexed marketId, address indexed disputer, uint256 counterOutcome, uint256 bond, uint256 fee, uint64 arbitrationDeadline)',
  'event Finalized(address indexed market, uint256 indexed marketId, uint256 outcome, address indexed proposer, uint256 reward)',
  'event Arbitrated(address indexed market, uint256 indexed marketId, uint256 outcome, address indexed winner, address loser, uint256 forfeited, uint256 reward)',
  'event Slashed(address indexed market, uint256 indexed marketId, address indexed account, uint256 amount, bool banned)',
  'event ProposalAbandoned(address indexed market, uint256 indexed marketId, address indexed proposer)',
  'event DisputeReset(address indexed market, uint256 indexed marketId)',
]);

/** The shared ban list. Mirrored so the API can explain a refused trade without an RPC round trip. */
export const BLOCKLIST_EVENTS = parseAbi([
  'event Banned(address indexed account, address indexed context, uint256 marketId, uint64 at)',
  'event Unbanned(address indexed account, address indexed by)',
]);

/**
 * Live resolution terms, read rather than cached.
 *
 * The bond is flat, but the reward tracks the market's own fee take and so moves with every trade.
 * A figure copied into the database at proposal time would be wrong by the time a trader read it,
 * and quoting a stale reward is quoting a payment we will not make.
 */
export const OPTIMISTIC_RESOLVER_VIEW = parseAbi([
  'function bond() view returns (uint256)',
  'function rewardFor(address market, uint256 marketId) view returns (uint256)',
  'function proposalFee() view returns (uint256)',
  'function disputeWindow() view returns (uint64)',
  'function arbitrationTimeout() view returns (uint64)',
  'function rewardPool() view returns (uint256)',
  'function rewardBps() view returns (uint16)',
  'function rewardCap() view returns (uint256)',
  'function INVALID_OUTCOME() view returns (uint256)',
]);

/** Views used to refresh public state after a trade. */
export const ENGINE_PRICE_VIEW = parseAbi([
  'function prices(uint256 marketId) view returns (uint256[])',
  'function outcomeShares(uint256 marketId, uint256 outcomeId) view returns (uint256)',
  'function collateralOf(uint256 marketId) view returns (uint256)',
]);

/** OpenZeppelin AccessControl — the authority for admin authorization. */
export const ACCESS_CONTROL_ABI = parseAbi([
  'function hasRole(bytes32 role, address account) view returns (bool)',
]);

/** Engine views used by the operator dashboard. */
export const ENGINE_VIEW_ABI = parseAbi([
  'function paused() view returns (bool)',
  'function feeRecipient() view returns (address)',
]);
