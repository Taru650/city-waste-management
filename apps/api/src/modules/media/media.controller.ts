import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../../common/auth-user';
import { Client } from '../../common/client-info';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../common/enums';
import { ClientInfo } from '../auth/session.service';
import { DevicesService } from './devices.service';
import { ConfirmUploadDto, CreateUploadDto, RegisterDeviceDto } from './dto/media.dto';
import { MediaService } from './media.service';

const uuid = new ParseUUIDPipe({ version: '4' });
/** Only the mobile apps capture evidence; the web portal never uploads media. */
const CAPTURING_ROLES = [Role.CITIZEN, Role.WORKER, Role.SUPERVISOR, Role.SUB_ADMIN];

@ApiTags('media')
@ApiBearerAuth()
@Roles(...CAPTURING_ROLES)
@Controller()
export class MediaController {
  constructor(private readonly media: MediaService, private readonly devices: DevicesService) {}

  @Post('devices')
  registerDevice(@CurrentUser() user: AuthUser, @Body() dto: RegisterDeviceDto, @Client() client: ClientInfo) {
    return this.devices.register(user, dto, client.ip);
  }

  @Get('devices')
  listDevices(@CurrentUser() user: AuthUser) {
    return this.devices.list(user);
  }

  @Delete('devices/:id') @HttpCode(204)
  async revokeDevice(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Client() client: ClientInfo) {
    await this.devices.revoke(user, id, client.ip);
  }

  @Post('media/upload-url')
  createUpload(@CurrentUser() user: AuthUser, @Body() dto: CreateUploadDto) {
    return this.media.createUpload(user, dto);
  }

  @Post('media/:id/confirm') @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: ConfirmUploadDto, @Client() client: ClientInfo) {
    return this.media.confirm(user, id, dto, client.ip);
  }

  @Get('media/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.media.getOwn(user, id);
  }
}
