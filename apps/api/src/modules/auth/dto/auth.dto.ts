import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { MOBILE_REGEX, NAME_REGEX } from '../../../common/validation';
import { PASSWORD_MAX } from '../password-policy';
import { AttestationFields } from '../../attestation/attestation.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterCitizenDto extends AttestationFields {
  @ApiProperty({ description: 'Home ward (District and ULB are derived from it). Profile only, not used to route complaints.' })
  @IsUUID()
  homeWardId: string;

  @ApiProperty() @Transform(trim) @IsString() @Length(2, 100) @Matches(NAME_REGEX, { message: 'name contains invalid characters' })
  name: string;

  @ApiPropertyOptional({ description: 'Father/husband name (optional, data minimisation)' })
  @IsOptional() @Transform(trim) @IsString() @Length(2, 100) @Matches(NAME_REGEX, { message: 'guardianName contains invalid characters' })
  guardianName?: string;

  @ApiProperty({ example: '9876543210' }) @Matches(MOBILE_REGEX, { message: 'mobile must be a 10-digit Indian mobile number' })
  mobile: string;

  @ApiProperty() @Transform(trim) @IsEmail() @MaxLength(120)
  email: string;

  @ApiProperty() @IsString() @MaxLength(PASSWORD_MAX)
  password: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4096)
  captchaToken?: string;
}

export class LoginDto {
  @ApiProperty({ description: 'Mobile number or email' }) @Transform(trim) @IsString() @Length(3, 120)
  identifier: string;

  @ApiProperty() @IsString() @MaxLength(PASSWORD_MAX)
  password: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4096)
  captchaToken?: string;
}

export class MfaTokenDto {
  @ApiProperty() @IsString() @MaxLength(2048)
  mfaToken: string;
}

export class MfaCodeDto extends MfaTokenDto {
  @ApiProperty({ example: '123456' }) @Matches(/^\d{6}$/)
  code: string;
}

export class RefreshDto {
  @ApiProperty() @IsString() @Length(20, 200)
  refreshToken: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(PASSWORD_MAX)
  currentPassword: string;

  @ApiProperty() @IsString() @MaxLength(PASSWORD_MAX)
  newPassword: string;
}

export class ForgotPasswordDto extends AttestationFields {
  @ApiProperty({ description: 'Mobile number or email' }) @Transform(trim) @IsString() @Length(3, 120)
  identifier: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4096)
  captchaToken?: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @Length(20, 200)
  token: string;

  @ApiProperty() @IsString() @MaxLength(PASSWORD_MAX)
  newPassword: string;
}

export class MfaRecoverDto extends MfaTokenDto {
  @ApiProperty({ example: 'ABCDE-FGHJK' }) @IsString() @Length(10, 16)
  recoveryCode: string;
}

export class TotpCodeDto {
  @ApiProperty({ example: '123456' }) @Matches(/^\d{6}$/)
  code: string;
}

export class PreferencesDto {
  @ApiProperty({ enum: ['hi', 'en'] }) @IsIn(['hi', 'en'])
  preferredLanguage: 'hi' | 'en';
}
