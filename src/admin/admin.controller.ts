import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';
import { AdminAccessService } from './admin-access.service';
import { RelayService } from '../relay/relay.service';
import { ProtocolRoleGuard, RequiresRole } from './guards/protocol-role.guard';
import { CreateMetadataDraftDto, UpsertCategoryDto } from './dto/admin.dto';

/**
 * Operator API. Authorization comes from **on-chain AccessControl roles** — the
 * caller proves wallet ownership via the normal JWT, and each route checks that
 * wallet against the contracts. The backend never holds operator keys: all
 * state-changing chain actions (createMarket, resolve, withdrawFees, pause) are
 * signed client-side, ideally by the multisig. These endpoints only manage
 * off-chain copy and surface what needs attention.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(ProtocolRoleGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly access: AdminAccessService,
    private readonly relay: RelayService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'On-chain roles held by the authenticated wallet (drives admin nav).' })
  async me(@CurrentUser('address') address: string) {
    const roles = await this.access.rolesOf(address);
    return { address, roles, isOperator: roles.length > 0 };
  }

  // ---- market metadata ----------------------------------------------------

  @Post('markets/drafts')
  @RequiresRole('MARKET_CREATOR', 'CURATOR')
  @ApiOperation({
    summary: 'Draft market copy; returns the metadataHash to pass to createMarket() on-chain.',
  })
  createDraft(@Body() dto: CreateMetadataDraftDto, @CurrentUser('address') address: string) {
    return this.admin.createDraft(dto, address);
  }

  @Get('markets/drafts')
  @RequiresRole('MARKET_CREATOR', 'CURATOR')
  @ApiOperation({ summary: 'List recent metadata drafts and whether each was adopted on-chain.' })
  listDrafts() {
    return this.admin.listDrafts();
  }

  // ---- categories ---------------------------------------------------------

  @Post('categories')
  @RequiresRole('CURATOR')
  @ApiOperation({ summary: 'Create or update a category (off-chain catalog entry).' })
  upsertCategory(@Body() dto: UpsertCategoryDto) {
    return this.admin.upsertCategory(dto);
  }

  @Get('categories')
  @RequiresRole('CURATOR')
  @ApiOperation({ summary: 'List all categories including disabled ones.' })
  listCategories() {
    return this.admin.listAllCategories();
  }

  // ---- operations ---------------------------------------------------------

  @Get('operations')
  @RequiresRole('MARKET_CREATOR', 'CURATOR', 'RESOLVER')
  @ApiOperation({
    summary:
      'Operations queue: markets awaiting a proposal, disputes awaiting the quorum, and proposals anyone may now finalize.',
  })
  operations() {
    return this.admin.operationsQueue();
  }

  @Get('treasury')
  @RequiresRole('FEE_MANAGER')
  @ApiOperation({ summary: 'Accrued protocol fees per engine, read live from chain.' })
  treasury() {
    return this.admin.treasury();
  }

  /**
   * The gas relayer's gauge: balance, today's spend, and the cap it is measured against.
   *
   * Here rather than on the relay controller, and role-guarded rather than public, because these
   * figures are only actionable by the people who can top the relayer up. Traders get a state from
   * `GET /relay/status` instead — a balance tells them nothing they can do anything about, and
   * published next to the daily cap it would tell an attacker how close a drain was to working.
   */
  @Get('relay')
  @RequiresRole('DEFAULT_ADMIN', 'MARKET_CREATOR', 'CURATOR', 'RESOLVER', 'FEE_MANAGER', 'PAUSER')
  @ApiOperation({ summary: 'Gas relayer gauge: balance, spend today, and the daily cap.' })
  relayGauge() {
    return this.relay.gauge();
  }
}
