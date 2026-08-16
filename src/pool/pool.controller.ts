import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PoolShieldDto, PoolWithdrawDto } from './dto/pool.dto';
import { PoolRejected, PoolService } from './pool.service';

/**
 * The shielded pool's HTTP surface: three routes, none of them authenticated.
 *
 * `@Public()` throughout, and that is the design rather than an omission. A session attached to any
 * of these would let our own logs record which signed-in user funded which market account — the
 * exact link the pool exists to destroy, rebuilt on infrastructure we control and would be the ones
 * asked to hand over. See `relay/relay.controller.ts`, which makes the same trade for the same
 * reason.
 *
 * What stands in for authentication is that none of these routes can be made to do anything harmful
 * on someone else's behalf:
 *
 *  - {state} is a mirror of public chain data and reveals nothing an observer could not index.
 *  - {withdraw} pays out only to the recipient sealed inside the proof's `context`, which the pool
 *    re-derives and checks itself.
 *  - {shield} moves value only into the note named inside the owner's own signature.
 *
 * The residual is that a stranger can spend our gas. That is bounded by the relay's daily cap and
 * the throttles below, and it is a cost, not a compromise.
 */
@ApiTags('pool')
@Controller('pool')
export class PoolController {
  constructor(private readonly pool: PoolService) {}

  @Public()
  @Get('state')
  @ApiOperation({
    summary: 'The shielded pool state tree and current roots, for building a withdrawal proof.',
  })
  state() {
    return this.pool.state();
  }

  @Public()
  @Post('withdraw')
  @HttpCode(200)
  // Tighter than the global limit: a withdrawal is two transactions at our expense. A coarse IP
  // backstop only — an attacker rotates IPs freely, and the real bound is the daily gas cap.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Submit a shielded withdrawal proof. Takes a proof, never a session.',
  })
  async withdraw(@Body() body: PoolWithdrawDto) {
    return this.attempt(() => this.pool.withdraw(body));
  }

  @Public()
  @Post('shield')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: "Return a gasless account's balance to the pool, authorised by its signature.",
  })
  async shield(@Body() body: PoolShieldDto) {
    return this.attempt(() => this.pool.shield(body));
  }

  /**
   * One refusal vocabulary for both write routes.
   *
   * 503 for "not now", 400 for "not ever". The distinction is the whole point: one tells the client
   * to retry and the other tells it to stop and show the user something. Collapsing them is how a
   * transient index lag turns into a permanent-looking error.
   */
  private async attempt(fn: () => Promise<{ hash: string }>) {
    try {
      const { hash } = await fn();
      return { status: 'submitted' as const, hash };
    } catch (err) {
      if (err instanceof PoolRejected) {
        if (err.kind === 'unavailable' || err.kind === 'stale') {
          throw new ServiceUnavailableException(err.message);
        }
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }
}
