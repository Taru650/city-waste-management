import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../../common/auth-user';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { Role } from '../../common/enums';
import {
  CreateAreaDto, CreateDistrictDto, CreateUlbDto, CreateWardDto, LocateQuery, UpdateAreaDto, UpdateComplaintTypeDto, UpdateWardDto,
} from './dto/masters.dto';
import { MastersService } from './masters.service';

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('masters')
@Controller('masters')
export class MastersController {
  constructor(private readonly masters: MastersService) {}

  // Public dropdown data for registration and complaint forms.
  @Public() @Get('districts')
  districts() {
    return this.masters.listDistricts();
  }

  @Public() @Get('districts/:id/ulbs')
  ulbs(@Param('id', uuid) id: string) {
    return this.masters.listUlbs(id);
  }

  @Public() @Get('ulbs/:id/wards')
  wards(@Param('id', uuid) id: string) {
    return this.masters.listWards(id);
  }

  @Public() @Get('complaint-types')
  complaintTypes() {
    return this.masters.listComplaintTypes();
  }

  @ApiBearerAuth() @Roles(Role.WEB_ADMIN)
  @Get('complaint-types/all')
  allComplaintTypes() {
    return this.masters.listComplaintTypes(true);
  }

  @ApiBearerAuth() @Roles(Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN, Role.SUPERVISOR)
  @Get('ulbs/:id/boundaries')
  boundaries(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.masters.wardBoundaries(user, id);
  }

  @ApiBearerAuth() @Get('locate')
  locate(@Query() q: LocateQuery) {
    return this.masters.locate(q.lat, q.lng);
  }

  @ApiBearerAuth() @Roles(Role.WEB_ADMIN)
  @Post('districts')
  createDistrict(@CurrentUser() user: AuthUser, @Body() dto: CreateDistrictDto) {
    return this.masters.createDistrict(user, dto);
  }

  @ApiBearerAuth() @Roles(Role.WEB_ADMIN, Role.DISTRICT_ADMIN)
  @Post('ulbs')
  createUlb(@CurrentUser() user: AuthUser, @Body() dto: CreateUlbDto) {
    return this.masters.createUlb(user, dto);
  }

  @ApiBearerAuth() @Roles(Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN)
  @Post('wards')
  createWard(@CurrentUser() user: AuthUser, @Body() dto: CreateWardDto) {
    return this.masters.createWard(user, dto);
  }

  @ApiBearerAuth() @Roles(Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN)
  @Patch('wards/:id')
  updateWard(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: UpdateWardDto) {
    return this.masters.updateWard(user, id, dto);
  }

  @ApiBearerAuth() @Roles(Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN)
  @Get('ulbs/:id/areas')
  areas(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.masters.listAreas(user, id);
  }

  @ApiBearerAuth() @Roles(Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN)
  @Post('areas')
  createArea(@CurrentUser() user: AuthUser, @Body() dto: CreateAreaDto) {
    return this.masters.createArea(user, dto);
  }

  @ApiBearerAuth() @Roles(Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN)
  @Patch('areas/:id')
  updateArea(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: UpdateAreaDto) {
    return this.masters.updateArea(user, id, dto);
  }

  @ApiBearerAuth() @Roles(Role.WEB_ADMIN)
  @Patch('complaint-types/:id')
  updateComplaintType(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: UpdateComplaintTypeDto) {
    return this.masters.updateComplaintType(user, id, dto);
  }
}
