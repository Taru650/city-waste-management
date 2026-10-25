import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../../common/auth-user';
import { Client } from '../../common/client-info';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { Role } from '../../common/enums';
import { AuthThrottle } from '../../common/throttle';
import { ClientInfo } from '../auth/session.service';
import { ConsentDto, CorrectProfileDto, ErasureDto } from './privacy.dto';
import { PrivacyService } from './privacy.service';

@ApiTags('privacy')
@Controller('privacy')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Public() @Get('notice')
  notice() {
    return this.privacy.notice();
  }

  @ApiBearerAuth() @Roles(Role.CITIZEN)
  @Post('consent') @HttpCode(200)
  consent(@CurrentUser() user: AuthUser, @Body() dto: ConsentDto) {
    return this.privacy.consent(user, dto);
  }

  @ApiBearerAuth() @Roles(Role.CITIZEN) @AuthThrottle()
  @Get('my-data')
  export(@CurrentUser() user: AuthUser) {
    return this.privacy.export(user);
  }

  @ApiBearerAuth() @Roles(Role.CITIZEN)
  @Patch('profile') @HttpCode(204)
  async correct(@CurrentUser() user: AuthUser, @Body() dto: CorrectProfileDto) {
    await this.privacy.correct(user, dto);
  }

  @ApiBearerAuth() @Roles(Role.CITIZEN) @AuthThrottle()
  @Post('erasure') @HttpCode(204)
  async erase(@CurrentUser() user: AuthUser, @Body() dto: ErasureDto, @Client() client: ClientInfo) {
    await this.privacy.erase(user, dto.password, client.ip);
  }
}
