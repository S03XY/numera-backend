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
import { PermitRequestDto, RelayRequestDto } from './dto/relay.dto';
import { RelayRejected, RelayService } from './relay.service';

/**
 * The gasless trading endpoint.
 *
 * `@Public()` is not an oversight — it is the design. A trader's market account must never hold
 * native gas, because a gas transfer from their wallet would publish the link between them and
 * every position that account holds. So the account signs and we send. Requiring a session here
 * would mean *our* logs recorded which user owns which account: the same link, rebuilt on our own
 * infrastructure, and worse because we would be the ones keeping it.
 *
 * The defences are therefore structural and economic rather than identity-based — a forwarder with
 * one frozen destination and four permitted selectors, and a contract-enforced minimum trade size
 * that makes each relayed operation pay for its own gas several times over. See {RelayService}.
 */
@ApiTags('relay')
@Controller('relay')
export class RelayController {
  constructor(private readonly relay: RelayService) {}

  @Public()
  @Post()
  @HttpCode(200)
  // Tighter than the global limit: this is the one route that spends money on a caller's behalf.
  // A coarse IP backstop only — the real bound is the per-account limit and the trade minimum,
  // because an attacker rotates both IPs and derived accounts freely.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Submit a signed trade for sponsored execution. Takes a signature, never a session.',
  })
  async submit(@Body() body: RelayRequestDto) {
    try {
      const { hash } = await this.relay.submit(body);
      return { status: 'submitted' as const, hash };
    } catch (err) {
      if (err instanceof RelayRejected) {
        // 503 for "not now", 400 for "not ever". The distinction matters to the client: one is
        // worth retrying and the other never is, and getting it wrong is how a UI retries a
        // permanently invalid request until the user gives up.
        if (err.code === 'unavailable' || err.code === 'rate-limited') {
          throw new ServiceUnavailableException(err.message);
        }
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Public()
  @Post('permit')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Submit a signed approval for the engine or Permit2. The only approval a gasless account cannot send itself.',
  })
  async permit(@Body() body: PermitRequestDto) {
    try {
      const { hash } = await this.relay.submitPermit(body);
      return { status: 'submitted' as const, hash };
    } catch (err) {
      if (err instanceof RelayRejected) {
        if (err.code === 'unavailable' || err.code === 'rate-limited') {
          throw new ServiceUnavailableException(err.message);
        }
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /**
   * The same bargain as trading, for the same reason.
   *
   * Whoever proposes an outcome is, overwhelmingly, someone holding it. A proposal signed by a login
   * wallet publishes which side that wallet is on — the exact link the product exists to prevent —
   * so proposals arrive from the trader's market account and we pay the gas.
   *
   * Cheaper to leave open than the trading endpoint, in fact: every call relayable here stakes a
   * bond in the same transaction, so there is no free request to spam with.
   */
  @Public()
  @Post('resolution')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Submit a signed proposal or dispute for sponsored execution, from a market account.',
  })
  async submitResolution(@Body() body: RelayRequestDto) {
    try {
      const { hash } = await this.relay.submitResolution(body);
      return { status: 'submitted' as const, hash };
    } catch (err) {
      if (err instanceof RelayRejected) {
        if (err.code === 'unavailable' || err.code === 'rate-limited') {
          throw new ServiceUnavailableException(err.message);
        }
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /**
   * Whether a bet can be placed right now. A state, never a gauge.
   *
   * This used to answer with the relayer's address, its balance, today's spend and the cap, to
   * anybody who asked. None of that is actionable by a trader, the balance is the weakest of the
   * signals we hold, and the spend-against-cap pair is a live scoreboard for anybody trying to
   * drain us. The numbers moved to `GET /admin/relay`, behind the on-chain role check.
   */
  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Whether gasless trading is available right now. No figures.' })
  status() {
    return this.relay.publicState();
  }
}
