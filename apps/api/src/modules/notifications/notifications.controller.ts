import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../../common/auth-user';
import { CurrentUser } from '../../common/decorators';
import { ListNotificationsQuery, PushTokenDto, RemovePushTokenDto } from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListNotificationsQuery) {
    return this.notifications.list(user, q);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user);
  }

  @Post('read-all') @HttpCode(204)
  async readAll(@CurrentUser() user: AuthUser) {
    await this.notifications.markAllRead(user);
  }

  @Post(':id/read') @HttpCode(204)
  async read(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    await this.notifications.markRead(user, id);
  }

  @Post('push-tokens') @HttpCode(204)
  async registerToken(@CurrentUser() user: AuthUser, @Body() dto: PushTokenDto) {
    await this.notifications.registerToken(user, dto);
  }

  @Delete('push-tokens') @HttpCode(204)
  async removeToken(@CurrentUser() user: AuthUser, @Body() dto: RemovePushTokenDto) {
    await this.notifications.removeToken(user, dto.token);
  }
}
