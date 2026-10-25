import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

export class PushTokenDto {
  // FCM tokens are URL-safe base64 plus ':' (~160–250 chars). The cap keeps the unique index safe.
  @ApiProperty({ description: 'FCM registration token of this app install' }) @IsString() @Length(20, 2048) @Matches(/^[A-Za-z0-9_:-]+$/)
  token: string;

  @ApiProperty({ enum: ['ANDROID', 'IOS'] }) @IsIn(['ANDROID', 'IOS'])
  platform: 'ANDROID' | 'IOS';
}

export class RemovePushTokenDto {
  @ApiProperty() @IsString() @Length(20, 2048) @Matches(/^[A-Za-z0-9_:-]+$/)
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
