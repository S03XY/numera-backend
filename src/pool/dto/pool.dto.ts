import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
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
 * Field elements travel as decimal strings, always.
 *
 * A `uint256` does not survive `JSON.parse` — it becomes a float and loses its low bits — and a
 * proof whose public signals were rounded verifies against nothing, with a revert that names the
 * pairing check rather than the JSON. Every numeric field in this file is a string for that reason.
 */

export class WithdrawalDto {
  @ApiProperty({ description: 'Must be the pool entrypoint: the pool pays whoever processes.' })
  @IsEthAddress()
  processooor!: string;

  @ApiProperty({ description: 'abi.encode(address recipient). Sealed inside the proof context.' })
  @Matches(HEX, { message: 'data must be 0x-prefixed hex of even length' })
  @IsNotEmpty()
  data!: string;
}

export class WithdrawProofDto {
  @ApiProperty({ type: [String], description: 'Groth16 A, two field elements.' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @Matches(UINT_STRING, { each: true })
  pA!: string[];

  @ApiProperty({
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
    description: 'Groth16 B. G2 coordinates, in the order the Solidity verifier expects.',
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  pB!: string[][];

  @ApiProperty({ type: [String], description: 'Groth16 C, two field elements.' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @Matches(UINT_STRING, { each: true })
  pC!: string[];

  @ApiProperty({
    type: [String],
    description:
      'The eight public signals, in circuit order: newCommitment, nullifierHash, value, ' +
      'stateRoot, stateDepth, aspRoot, aspDepth, context.',
  })
  @IsArray()
  @ArrayMinSize(8)
  @ArrayMaxSize(8)
  @Matches(UINT_STRING, { each: true })
  pubSignals!: string[];
}

/**
 * A shielded withdrawal, submitted by whoever generated the proof and paid for by us.
 *
 * Unauthenticated, like every relay endpoint here, and for the same reason: a session cookie
 * attached to this request would tell our own logs which user funded which market account, which is
 * the exact link the pool exists to destroy. The proof is the authorisation, and it is a better one
 * than a session — it names its own recipient, and the pool checks that naming itself.
 */
export class PoolWithdrawDto {
  @ApiProperty({ type: WithdrawalDto })
  @ValidateNested()
  @Type(() => WithdrawalDto)
  withdrawal!: WithdrawalDto;

  @ApiProperty({ type: WithdrawProofDto })
  @ValidateNested()
  @Type(() => WithdrawProofDto)
  proof!: WithdrawProofDto;
}

export class ShieldRequestDto {
  @ApiProperty({ description: 'The gasless account whose balance is being returned to the pool.' })
  @IsEthAddress()
  owner!: string;

  @ApiProperty({ description: 'Collateral to shield, base units.' })
  @Matches(UINT_STRING, { message: 'value must be a decimal uint string' })
  value!: string;

  @ApiProperty({ description: 'Poseidon(nullifier, secret). Inside the signature, so unforgeable.' })
  @Matches(UINT_STRING, { message: 'precommitment must be a decimal uint string' })
  precommitment!: string;

  @ApiProperty({ description: 'Unix seconds after which the instruction is dead.' })
  @Matches(UINT_STRING, { message: 'deadline must be a decimal uint string' })
  deadline!: string;
}

/** The EIP-2612 half: the allowance a gasless account cannot grant by transaction. */
export class ShieldPermitDto {
  @ApiProperty()
  @Matches(UINT_STRING, { message: 'deadline must be a decimal uint string' })
  deadline!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(255)
  v!: number;

  @ApiProperty()
  @Matches(BYTES32)
  r!: string;

  @ApiProperty()
  @Matches(BYTES32)
  s!: string;
}

/**
 * A market account returning its balance to the shielded pool, gaslessly.
 *
 * The account signs; we send. What makes this safe to expose without authentication is that
 * `precommitment` is inside the signed struct — the note belongs to whoever signed, and no
 * submitter, including us, can point it anywhere else.
 */
export class PoolShieldDto {
  @ApiProperty({ type: ShieldRequestDto })
  @ValidateNested()
  @Type(() => ShieldRequestDto)
  request!: ShieldRequestDto;

  @ApiProperty({ description: "The owner's EIP-712 Shield signature." })
  @Matches(/^0x[0-9a-fA-F]{130}$/, { message: 'signature must be 65 bytes of hex' })
  signature!: string;

  @ApiPropertyOptional({
    type: ShieldPermitDto,
    description: 'Omit when the allowance already exists.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShieldPermitDto)
  permit?: ShieldPermitDto;
}
