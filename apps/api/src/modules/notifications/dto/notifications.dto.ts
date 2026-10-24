import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class PushTokenDto {
  @ApiProperty({ description: 'FCM registration token of this app install' }) @IsString() @Length(20, 4096)
  token: string;

  @ApiProperty({ enum: ['ANDROID', 'IOS'] }) @IsIn(['ANDROID', 'IOS'])
  platform: 'ANDROID' | 'IOS';
}

export class RemovePushTokenDto {
  @ApiProperty() @IsString() @Length(20, 4096)
  token: string;
}

export class ListNotificationsQuery {
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  unread?: boolean;

  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000)
  page = 1;

  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize = 20;
}
