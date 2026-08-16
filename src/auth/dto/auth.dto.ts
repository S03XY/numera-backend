import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength, Matches } from 'class-validator';
import { IsEthAddress } from '../../common/decorators/is-eth-address.decorator';

export class RequestNonceDto {
  @ApiProperty({ example: '0x1111111111111111111111111111111111111111' })
  @IsEthAddress()
  address!: string;
}

export class VerifySignatureDto {
  @ApiProperty({ description: 'The exact SIWE message string that was signed.' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message!: string;

  @ApiProperty({ example: '0x...', description: 'The 65-byte signature over the message.' })
  @IsString()
  @Matches(/^0x[0-9a-fA-F]+$/, { message: 'signature must be 0x-hex' })
  @MaxLength(2000)
  signature!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  refreshToken!: string;
}
