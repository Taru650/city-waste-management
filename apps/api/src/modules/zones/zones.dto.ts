import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateIf } from 'class-validator';
import { GeoJsonPolygon, IsGeoJsonPolygon } from '../../common/geojson.validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateEventZoneDto {
  @ApiProperty({ description: 'ULB the zone belongs to (Sub Admins: always their own)' }) @IsUUID()
  ulbId: string;

  @ApiProperty() @Transform(trim) @IsString() @Length(3, 120)
  name: string;

  @ApiProperty({ description: 'GeoJSON Polygon/MultiPolygon' }) @IsGeoJsonPolygon()
  boundary: GeoJsonPolygon;

  @ApiProperty() @IsISO8601({ strict: true })
  startsAt: string;

  @ApiProperty() @IsISO8601({ strict: true })
  endsAt: string;

  @ApiPropertyOptional({ description: 'Supervisor of the same ULB who handles complaints inside the zone' })
  @IsOptional() @IsUUID()
  supervisorId?: string;

  @ApiPropertyOptional({ description: 'Deadline in hours inside the zone; the shorter of this and the type SLA applies' })
  @IsOptional() @IsInt() @Min(1) @Max(720)
  slaHours?: number;
}

export class UpdateEventZoneDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(3, 120)
  name?: string;

  @ApiPropertyOptional() @IsOptional() @IsGeoJsonPolygon()
  boundary?: GeoJsonPolygon;

  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true })
  startsAt?: string;

  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true })
  endsAt?: string;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()
  supervisorId?: string | null;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(720)
  slaHours?: number | null;

  @ApiPropertyOptional({ description: 'false cancels the zone (open complaints are handed back)' }) @IsOptional() @IsBoolean()
  active?: boolean;
}

export class ListEventZonesQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID()
  ulbId?: string;

  @ApiPropertyOptional({ enum: ['current', 'upcoming', 'past', 'all'], default: 'all' })
  @IsOptional() @IsIn(['current', 'upcoming', 'past', 'all'])
  when: 'current' | 'upcoming' | 'past' | 'all' = 'all';
}
