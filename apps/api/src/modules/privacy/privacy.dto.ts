import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import { NAME_REGEX } from '../../common/validation';
import { PASSWORD_MAX } from '../auth/password-policy';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ConsentDto {
  @ApiProperty({ description: 'The notice version the citizen was shown (GET /privacy/notice)' }) @IsString() @MaxLength(20)
  noticeVersion: string;

  @ApiProperty({ enum: ['hi', 'en'], description: 'Language the notice was shown in' }) @IsIn(['hi', 'en'])
  language: 'hi' | 'en';
}

export class CorrectProfileDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 100) @Matches(NAME_REGEX, { message: 'name contains invalid characters' })
  name?: string;

  @ApiPropertyOptional({ nullable: true, description: 'null removes it' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(trim) @IsString() @Length(2, 100) @Matches(NAME_REGEX, { message: 'guardianName contains invalid characters' })
  guardianName?: string | null;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsEmail() @MaxLength(120)
  email?: string;
}

export class ErasureDto {
  @ApiProperty({ description: 'Current password: erasure cannot be undone' }) @IsString() @MaxLength(PASSWORD_MAX)
  password: string;
}
