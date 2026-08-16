import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsEthAddress } from '../../common/decorators/is-eth-address.decorator';

const UINT_STRING = /^[0-9]{1,78}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * A signed ERC-2771 request.
 *
 * Numbers arrive as decimal strings because `JSON.parse` cannot represent a `uint256`, and a value
 * silently truncated to a float would be verified against different data than it was signed over.
 */
export class ForwardRequestDto {
  @ApiProperty({ description: 'The market account that signed. Never a user wallet.' })
  @IsEthAddress()
  from!: string;

  @ApiProperty({ description: 'Must be the engine the forwarder is wired to.' })
  @IsEthAddress()
  to!: string;

  @ApiProperty({ description: 'Always "0" — the engine is not payable.' })
  @Matches(UINT_STRING, { message: 'value must be a decimal uint string' })
  value!: string;

  @ApiProperty({ description: 'Gas to forward to the engine call.' })
  @Matches(UINT_STRING, { message: 'gas must be a decimal uint string' })
  gas!: string;

  @ApiProperty({ description: 'Unix seconds after which the request is dead.' })
  @IsInt()
  @Min(0)
  @Max(281_474_976_710_655) // uint48
  deadline!: number;

  @ApiProperty({ description: 'ABI-encoded engine call. Only buy/buyComplement/sell/redeem.' })
  @Matches(HEX, { message: 'data must be 0x-prefixed hex of even length' })
  @IsNotEmpty()
  data!: string;

  @ApiProperty({ description: 'EIP-712 signature over the request.' })
  @Matches(/^0x[0-9a-fA-F]{130}$/, { message: 'signature must be 65 bytes of hex' })
  signature!: string;
}

/**
 * An EIP-2612 approval, relayed only when bundled with a trade.
 *
 * Never accepted on its own: `permit` is permissionless by design, so a standalone permit endpoint
 * would let a stranger have us pay for their approvals. Bundled, it costs an attacker a trade they
 * must also fund.
 */
export class PermitDto {
  @ApiProperty()
  @IsEthAddress()
  owner!: string;

  @ApiProperty()
  @Matches(UINT_STRING, { message: 'value must be a decimal uint string' })
  value!: string;

  @ApiProperty()
  @Matches(UINT_STRING, { message: 'deadline must be a decimal uint string' })
  deadline!: string;

  @ApiProperty({ minimum: 27, maximum: 28 })
  @IsInt()
  @Min(27)
  @Max(28)
  v!: number;

  @ApiProperty()
  @Matches(BYTES32, { message: 'r must be 32 bytes of hex' })
  r!: string;

  @ApiProperty()
  @Matches(BYTES32, { message: 's must be 32 bytes of hex' })
  s!: string;
}

export class RelayRequestDto {
  @ApiProperty({ type: ForwardRequestDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ForwardRequestDto)
  request!: ForwardRequestDto;

  @ApiPropertyOptional({ type: PermitDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PermitDto)
  permit?: PermitDto;
}

/**
 * A standalone approval, for the one case that needs it.
 *
 * `token` and `spender` are both checked against the relayer's own configuration rather than
 * trusted: the whole safety of relaying an approval on its own rests on it only ever being able to
 * name our engine or Permit2.
 */
export class PermitRequestDto {
  @ApiProperty({ description: 'The collateral token.' })
  @IsEthAddress()
  token!: string;

  @ApiProperty({ description: 'The market account granting the allowance.' })
  @IsEthAddress()
  owner!: string;

  @ApiProperty({ description: 'Must be the Numera engine or Permit2.' })
  @IsEthAddress()
  spender!: string;

  @ApiProperty()
  @Matches(UINT_STRING, { message: 'value must be a decimal uint string' })
  value!: string;

  @ApiProperty()
  @Matches(UINT_STRING, { message: 'deadline must be a decimal uint string' })
  deadline!: string;

  @ApiProperty({ minimum: 27, maximum: 28 })
  @IsInt()
  @Min(27)
  @Max(28)
  v!: number;

  @ApiProperty()
  @Matches(BYTES32, { message: 'r must be 32 bytes of hex' })
  r!: string;

  @ApiProperty()
  @Matches(BYTES32, { message: 's must be 32 bytes of hex' })
  s!: string;
}
