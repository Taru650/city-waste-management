import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../../common/auth-user';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../common/enums';
import { CreateEventZoneDto, ListEventZonesQuery, UpdateEventZoneDto } from './zones.dto';
import { ZonesService } from './zones.service';

const MANAGERS = [Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN];
const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('event-zones')
@ApiBearerAuth()
@Controller('event-zones')
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  @Roles(...MANAGERS, Role.SUPERVISOR)
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListEventZonesQuery) {
    return this.zones.list(user, q);
  }

  @Roles(...MANAGERS, Role.SUPERVISOR)
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.zones.get(user, id);
  }

  @Roles(...MANAGERS)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateEventZoneDto) {
    return this.zones.create(user, dto);
  }

  @Roles(...MANAGERS)
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: UpdateEventZoneDto) {
    return this.zones.update(user, id, dto);
  }
}
