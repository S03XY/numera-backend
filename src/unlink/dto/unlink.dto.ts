import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Unlink addresses are bech32m with an `unlink1` prefix. Validated at the edge so
 * a malformed value fails as a 400 here rather than as an opaque vendor error.
 */
const UNLINK_ADDRESS = /^unlink1[023456789acdefghjklmnpqrstuvwxyz]{6,120}$/;

export class RegisterUnlinkDto {
  @ApiProperty({
    description:
      'Registration payload produced by the browser SDK (`account.toRegistrationPayload`). ' +
      'Wire form, snake_case. Validated against the SDK schema server-side.',
  })
  @IsObject()
  payload!: Record<string, unknown>;
}

export class AuthorizationTokenDto {
  @ApiProperty({
    description: 'The Unlink address to mint a token for. Must belong to the calling session.',
    example: 'unlink1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  })
  @IsString()
  @MaxLength(200)
  @Matches(UNLINK_ADDRESS, { message: 'unlinkAddress must be a bech32m unlink1… address' })
  unlinkAddress!: string;
}
