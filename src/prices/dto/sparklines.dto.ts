import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/**
 * Sparkline request for a whole board at once.
 *
 * Deliberately batched. The board renders every market as a card, and a per-card price history
 * request means one query per card on every page of results — the classic N+1, paid on the
 * screen users land on first. One request covering the visible page keeps the board's cost
 * independent of its length.
 */
export class SparklinesQueryDto {
  @ApiProperty({
    description: 'Comma-separated market UUIDs.',
    example: '11111111-1111-4111-8111-111111111111,2222...',
  })
  // Split before validation so `@IsUUID(..., { each: true })` sees an array. An empty segment
  // would otherwise pass through as '' and fail with a confusing per-item message.
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : value,
  )
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  // Bounds the `= ANY($1)` scan. Comfortably above one page of the board.
  @ArrayMaxSize(60)
  markets!: string[];

  @ApiPropertyOptional({ description: 'Outcome index to trace', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(255)
  outcome = 0;

  @ApiPropertyOptional({ description: 'Window in hours', default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24 * 30)
  hours = 24;
}
