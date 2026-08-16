import { Body, Controller, ForbiddenException, Get, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthorizationTokenDto, RegisterUnlinkDto } from './dto/unlink.dto';
import { UnlinkIdentityService } from './unlink-identity.service';
import { UnlinkService } from './unlink.service';

/**
 * The browser's trust boundary with Unlink.
 *
 * The admin API key lives only on this side. Browsers register once, then exchange
 * their app session for short-lived authorization tokens and talk to Engine directly.
 */
@ApiTags('unlink')
@Controller('unlink')
export class UnlinkController {
  private readonly log = new Logger(UnlinkController.name);

  constructor(
    private readonly unlink: UnlinkService,
    private readonly identity: UnlinkIdentityService,
  ) {}

  @Public()
  @Get('environment')
  @ApiOperation({
    summary: 'Whether private trading is available here, and which Engine to bind to.',
  })
  async environment() {
    if (!this.unlink.isEnabled) {
      // A 200 with `enabled:false` rather than a 503: "this deployment has no
      // privacy layer" is a normal answer the wallet screen renders, not a fault.
      return { enabled: false as const };
    }
    const info = await this.unlink.environment();
    return {
      enabled: true as const,
      environment: this.unlink.environmentName,
      chainId: info.chain_id,
      poolAddress: info.pool_address,
      permit2Address: info.permit2_address,
      executionAccountsEnabled: info.execution_account.enabled,
    };
  }

  @Post('register')
  @HttpCode(200)
  @ApiOperation({
    summary: "Register the caller's Unlink keys with Engine and bind them to this account.",
  })
  async register(
    @Body() dto: RegisterUnlinkDto,
    @CurrentUser('userId') userId: string,
  ): Promise<{ address: string }> {
    const { address } = await this.unlink.register(dto.payload);
    // Bind before returning: a client that registered but never got bound would
    // be unable to obtain a token, and re-registering would not fix it.
    await this.identity.bind(userId, address);
    return { address };
  }

  @Post('authorization-token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mint a short-lived Engine authorization token for the caller.' })
  async authorizationToken(
    @Body() dto: AuthorizationTokenDto,
    @CurrentUser('userId') userId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const owns = await this.identity.owns(userId, dto.unlinkAddress);
    if (!owns) {
      // This token grants read access to the address's balances and history, so a
      // mismatch is refused outright rather than silently issuing a narrower token.
      this.log.warn(`Rejected authorization-token request for an unowned Unlink address.`);
      throw new ForbiddenException('This session does not own that Unlink address.');
    }

    const { token, expiresAt } = await this.unlink.issueAuthorizationToken(dto.unlinkAddress);
    return { token, expiresAt: expiresAt.toISOString() };
  }
}
