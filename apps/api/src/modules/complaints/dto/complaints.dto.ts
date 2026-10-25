import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsEnum, IsInt, IsISO8601, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { ComplaintStatus } from '../../../common/enums';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class GeoPointDto {
  @ApiProperty() @IsLatitude()
  lat: number;

  @ApiProperty() @IsLongitude()
  lng: number;

  @ApiPropertyOptional({ description: 'Reported GPS accuracy in metres' }) @IsOptional() @IsNumber() @Min(0) @Max(10_000)
  accuracyM?: number;
}

export class CreateComplaintDto {
  @ApiProperty() @IsUUID()
  typeId: string;

  @ApiProperty({ description: 'Where the problem is (captured with the photo).' }) @IsLatitude()
  lat: number;

  @ApiProperty() @IsLongitude()
  lng: number;

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(10_000)
  gpsAccuracyM?: number;

  @ApiPropertyOptional({
    description: 'Ward chosen by the citizen. Omit to use the ward detected from GPS. Any ward of any ULB is allowed.',
  })
  @IsOptional() @IsUUID()
  wardId?: string;

  @ApiPropertyOptional({ maxLength: 50 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(50)
  landmark?: string;

  @ApiProperty({ maxLength: 250 }) @Transform(trim) @IsString() @Length(5, 250)
  description: string;

  @ApiProperty({ type: [String], description: 'Verified in-app captures (POST /media/upload-url → confirm). 1–6 items.' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @ArrayUnique() @IsUUID('4', { each: true })
  mediaIds: string[];
}

class ProofMedia {
  @ApiPropertyOptional({ type: [String], description: 'In-app photos/video. Required (≥1 photo) when a worker starts or resolves.' })
  @IsOptional() @IsArray() @ArrayMaxSize(6) @ArrayUnique() @IsUUID('4', { each: true })
  mediaIds?: string[];
}

export class AssignDto {
  @ApiPropertyOptional({ description: 'Sanitation worker of the same ULB' }) @IsOptional() @IsUUID()
  workerId?: string;

  @ApiPropertyOptional({ description: 'Sub Admin only: hand the complaint to a supervisor' }) @IsOptional() @IsUUID()
  supervisorId?: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  remark?: string;
}

export class StartWorkDto extends ProofMedia {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  remark?: string;

  @ApiPropertyOptional({ type: GeoPointDto }) @IsOptional() @ValidateNested() @Type(() => GeoPointDto)
  location?: GeoPointDto;
}

export class ResolveDto extends ProofMedia {
  @ApiProperty() @Transform(trim) @IsString() @Length(5, 500)
  remark: string;

  @ApiPropertyOptional({ type: GeoPointDto, description: 'Where the resolver is standing' }) @IsOptional() @ValidateNested() @Type(() => GeoPointDto)
  location?: GeoPointDto;
}

export class RejectDto {
  @ApiProperty() @Transform(trim) @IsString() @Length(5, 500)
  reason: string;
}

export class DuplicateDto {
  @ApiProperty({ description: 'The original complaint' }) @IsUUID()
  duplicateOfId: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  remark?: string;
}

export class FeedbackDto {
  @ApiProperty({ minimum: 1, maximum: 5 }) @IsInt() @Min(1) @Max(5)
  rating: number;

  @ApiPropertyOptional({ maxLength: 250 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(250)
  remark?: string;

  @ApiPropertyOptional({ description: 'Only allowed with a rating of 1 or 2' }) @IsOptional() @IsBoolean()
  reopen?: boolean;
}

export class ListComplaintsQuery {
  @ApiPropertyOptional({ enum: ComplaintStatus }) @IsOptional() @IsEnum(ComplaintStatus)
  status?: ComplaintStatus;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  ulbId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  wardId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  typeId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  eventZoneId?: string;

  @ApiPropertyOptional() @IsOptional() @IsISO8601()
  from?: string;

  @ApiPropertyOptional() @IsOptional() @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Escalated (SLA ×2 or repeated reopen)' })
  @IsOptional() @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value)) @IsBoolean()
  escalated?: boolean;

  @ApiPropertyOptional({ description: 'Only complaints still being worked on (PENDING, ASSIGNED, WORK_IN_PROGRESS, REOPENED)' })
  @IsOptional() @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value)) @IsBoolean()
  open?: boolean;

  @ApiPropertyOptional({ description: 'Open and past the SLA deadline' })
  @IsOptional() @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value)) @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000)
  page = 1;

  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize = 20;
}
