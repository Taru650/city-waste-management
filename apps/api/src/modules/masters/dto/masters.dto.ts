import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsLatitude, IsLongitude, IsOptional, IsString, IsUUID, Length, Max, Min,
} from 'class-validator';
import { UlbType } from '../../../common/enums';
import { GeoJsonPolygon, IsGeoJsonPolygon } from '../../../common/geojson.validator';

export class CreateDistrictDto {
  @ApiProperty({ description: 'LGD district code' }) @IsInt() @Min(1) @Max(9999)
  lgdCode: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(9999)
  census2011Code?: number;

  @ApiProperty() @IsString() @Length(2, 100)
  name: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100)
  nameHi?: string;
}

export class CreateUlbDto {
  @ApiProperty() @IsUUID()
  districtId: string;

  @ApiProperty({ description: 'LGD urban local body code' }) @IsInt() @Min(1) @Max(999999)
  lgdCode: number;

  @ApiProperty({ enum: UlbType }) @IsEnum(UlbType)
  type: UlbType;

  @ApiProperty() @IsString() @Length(2, 150)
  name: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 150)
  nameHi?: string;

  @ApiPropertyOptional({ description: 'GeoJSON Polygon/MultiPolygon' }) @IsOptional() @IsGeoJsonPolygon()
  boundary?: GeoJsonPolygon;
}

export class CreateWardDto {
  @ApiProperty() @IsUUID()
  ulbId: string;

  @ApiProperty() @IsInt() @Min(1) @Max(9999)
  number: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100)
  name?: string;

  @ApiPropertyOptional({ description: 'GeoJSON Polygon/MultiPolygon' }) @IsOptional() @IsGeoJsonPolygon()
  boundary?: GeoJsonPolygon;
}

export class UpdateWardDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100)
  name?: string;

  @ApiPropertyOptional() @IsOptional() @IsGeoJsonPolygon()
  boundary?: GeoJsonPolygon;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  active?: boolean;
}

export class CreateAreaDto {
  @ApiProperty() @IsUUID()
  ulbId: string;

  @ApiProperty() @IsString() @Length(1, 100)
  name: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  supervisorId?: string;

  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true })
  wardIds: string[];
}

export class UpdateAreaDto {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID()
  supervisorId?: string;

  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true })
  wardIds?: string[];
}

export class UpdateComplaintTypeDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(24 * 30)
  slaHours?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  active?: boolean;
}

export class LocateQuery {
  @ApiProperty() @Type(() => Number) @IsLatitude()
  lat: number;

  @ApiProperty() @Type(() => Number) @IsLongitude()
  lng: number;
}
