import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Copy for a market, drafted before it is created on-chain. */
export class CreateMetadataDraftDto {
  @ApiProperty({ example: 'World Cup Final: Argentina vs France' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiProperty({
    description:
      'How this market settles: the source of truth, when it is read, and what happens if the ' +
      'event does not occur as described. Committed to metadataHash, so it cannot be reworded ' +
      'after anyone has bet on it.',
    example:
      'Settles to the team leading at the final whistle of regulation plus stoppage time, per ' +
      'the official FIFA match report. Extra time and penalties do not count. If the match is ' +
      'abandoned or postponed beyond the close time, the market is voided.',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(5000)
  resolutionRules!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  imageUrl?: string;

  @ApiProperty({
    type: [String],
    description: 'Outcome labels in on-chain outcome order (index 0..n-1).',
    example: ['Argentina', 'Draw', 'France'],
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  outcomeLabels!: string[];

  @ApiPropertyOptional({ example: 'SPORTS' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  categoryKey?: string;
}

export class UpsertCategoryDto {
  @ApiProperty({ example: 'SPORTS', description: 'Uppercase tag; must match the on-chain bytes32.' })
  @IsString()
  @Matches(/^[A-Z0-9_]{1,31}$/, {
    message: 'key must be 1-31 chars of A-Z, 0-9 or _ (fits a bytes32 tag)',
  })
  key!: string;

  @ApiProperty({ example: 'Sports' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  label!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
