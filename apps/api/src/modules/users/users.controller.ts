import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../../common/auth-user';
import { Client } from '../../common/client-info';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../common/enums';
import { ClientInfo } from '../auth/session.service';
import { CreateStaffDto, ListUsersQuery, UpdateStatusDto } from './dto/users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Roles(Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStaffDto, @Client() client: ClientInfo) {
    return this.users.createStaff(user, dto, client.ip);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListUsersQuery) {
    return this.users.list(user, q.role);
  }

  @Patch(':id/status')
  setStatus(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateStatusDto, @Client() client: ClientInfo) {
    return this.users.setStatus(user, id, dto, client.ip);
  }

  @Post(':id/reset-password')
  resetPassword(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Client() client: ClientInfo) {
    return this.users.helpdeskResetPassword(user, id, client.ip);
  }
}
