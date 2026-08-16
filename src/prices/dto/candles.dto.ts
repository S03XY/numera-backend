import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export enum CandleInterval {
  M1 = '1m',
  M5 = '5m',
  M15 = '15m',
  H1 = '1h',
  H4 = '4h',
  D1 = '1d',
}

/** Whitelisted mapping to Postgres interval literals (never user-interpolated). */
export const INTERVAL_SQL: Record<CandleInterval, string> = {
  [CandleInterval.M1]: '1 minute',
  [CandleInterval.M5]: '5 minutes',
  [CandleInterval.M15]: '15 minutes',
  [CandleInterval.H1]: '1 hour',
  [CandleInterval.H4]: '4 hours',
  [CandleInterval.D1]: '1 day',
};

export class CandlesQueryDto {
  @ApiPropertyOptional({ enum: CandleInterval, default: CandleInterval.M1 })
  @IsOptional()
  @IsEnum(CandleInterval)
  interval: CandleInterval = CandleInterval.M1;

  @ApiPropertyOptional({ description: 'Outcome index', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(255)
  outcome = 0;

  @ApiPropertyOptional({ description: 'ISO start time (defaults to 24h ago).' })
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO end time (defaults to now).' })
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({ default: 500, maximum: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit = 500;
}
