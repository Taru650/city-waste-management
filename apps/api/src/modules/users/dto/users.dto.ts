import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { Role, STAFF_ROLES, UserStatus } from '../../../common/enums';
import { MOBILE_REGEX, NAME_REGEX } from '../../../common/validation';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateStaffDto {
  @ApiProperty({ enum: STAFF_ROLES }) @IsIn(STAFF_ROLES)
  role: Role;

  @ApiProperty() @Transform(trim) @IsString() @Length(2, 100) @Matches(NAME_REGEX, { message: 'name contains invalid characters' })
  name: string;

  @ApiProperty() @Matches(MOBILE_REGEX, { message: 'mobile must be a 10-digit Indian mobile number' })
  mobile: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsEmail() @MaxLength(120)
  email?: string;

  @ApiPropertyOptional({ description: 'Required when creating a District Admin' }) @IsOptional() @IsUUID()
  districtId?: string;

  @ApiPropertyOptional({ description: 'Required when a District Admin creates a Sub Admin' }) @IsOptional() @IsUUID()
  ulbId?: string;

  @ApiPropertyOptional({ description: 'Optional home area for a worker' }) @IsOptional() @IsUUID()
  areaId?: string;
}

export class UpdateStatusDto {
  @ApiProperty({ enum: [UserStatus.ACTIVE, UserStatus.DISABLED] }) @IsEnum(UserStatus) @IsIn([UserStatus.ACTIVE, UserStatus.DISABLED])
  status: UserStatus;
}

export class ListUsersQuery {
  @ApiPropertyOptional({ enum: Role }) @IsOptional() @IsEnum(Role)
  role?: Role;
}
