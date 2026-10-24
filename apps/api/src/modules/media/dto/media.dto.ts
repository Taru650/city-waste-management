import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBase64, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export enum MediaKind {
  PHOTO = 'PHOTO',
  VIDEO = 'VIDEO',
}

export const ALLOWED_TYPES: Record<MediaKind, string[]> = {
  [MediaKind.PHOTO]: ['image/jpeg', 'image/webp'],
  [MediaKind.VIDEO]: ['video/mp4'],
};

export const MAX_BYTES: Record<MediaKind, number> = {
  [MediaKind.PHOTO]: 8 * 1024 * 1024,
  [MediaKind.VIDEO]: 60 * 1024 * 1024,
};

export class RegisterDeviceDto {
  @ApiProperty({ description: 'EC P-256 public key, DER/SPKI, base64. Private key stays in Android Keystore / Secure Enclave.' })
  @IsBase64() @MaxLength(1024)
  publicKey: string;

  @ApiProperty({ enum: ['ANDROID', 'IOS'] }) @IsIn(['ANDROID', 'IOS'])
  platform: 'ANDROID' | 'IOS';

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30)
  appVersion?: string;
}

export class CreateUploadDto {
  @ApiProperty() @IsUUID()
  deviceId: string;

  @ApiProperty({ enum: MediaKind }) @IsEnum(MediaKind)
  kind: MediaKind;

  @ApiProperty({ enum: [...ALLOWED_TYPES.PHOTO, ...ALLOWED_TYPES.VIDEO] }) @IsIn([...ALLOWED_TYPES.PHOTO, ...ALLOWED_TYPES.VIDEO])
  contentType: string;

  @ApiProperty({ description: 'Exact byte size of the compressed file' }) @IsInt() @Min(1) @Max(MAX_BYTES.VIDEO)
  bytes: number;

  @ApiProperty({ description: 'Hex SHA-256 of the file' }) @Matches(/^[a-f0-9]{64}$/)
  sha256: string;
}

export class ConfirmUploadDto {
  @ApiProperty({ description: 'base64url of the exact JSON capture manifest that was signed' })
  @IsString() @MaxLength(4096) @Matches(/^[A-Za-z0-9_-]+$/)
  manifest: string;

  @ApiProperty({ description: 'base64 DER ECDSA-SHA256 signature over the manifest bytes' })
  @IsBase64() @MaxLength(512)
  signature: string;
}
