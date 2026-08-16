import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Engine, MarketStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export enum MarketSort {
  CloseTime = 'closeTime',
  CreatedAt = 'createdAt',
  Pot = 'pot',
}

export enum SortOrder {
  Asc = 'asc',
  Desc = 'desc',
}

export class ListMarketsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: MarketStatus })
  @IsOptional()
  @IsEnum(MarketStatus)
  status?: MarketStatus;

  @ApiPropertyOptional({ enum: Engine })
  @IsOptional()
  @IsEnum(Engine)
  engine?: Engine;

  @ApiPropertyOptional({ description: 'Category key, e.g. SPORTS' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;

  @ApiPropertyOptional({ description: 'Case-insensitive title search' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({
    description: 'Only markets still open for trading (status TRADING and not past close).',
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  openOnly?: boolean;

  @ApiPropertyOptional({ enum: MarketSort, default: MarketSort.CreatedAt })
  @IsOptional()
  @IsEnum(MarketSort)
  sort: MarketSort = MarketSort.CreatedAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  order: SortOrder = SortOrder.Desc;
}
