import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../../common/auth-user';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../common/enums';
import { ComplaintsService } from './complaints.service';
import {
  AssignDto, CreateComplaintDto, DuplicateDto, FeedbackDto, ListComplaintsQuery, RejectDto, ResolveDto, StartWorkDto,
} from './dto/complaints.dto';

const uuid = new ParseUUIDPipe({ version: '4' });
const TRIAGE = [Role.SUPERVISOR, Role.SUB_ADMIN];

/**
 * One complaint API for all clients: the citizen app, the staff app (supervisor/worker)
 * and the web portal. What each caller sees and may do is decided server-side by role
 * and jurisdiction, never by which client is calling.
 */
@ApiTags('complaints')
@ApiBearerAuth()
@Controller('complaints')
export class ComplaintsController {
  constructor(private readonly complaints: ComplaintsService) {}

  @Roles(Role.CITIZEN)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateComplaintDto) {
    return this.complaints.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListComplaintsQuery) {
    return this.complaints.list(user, q);
  }

  @Get('track/:complaintNo')
  track(@CurrentUser() user: AuthUser, @Param('complaintNo') complaintNo: string) {
    return this.complaints.getByNumber(user, complaintNo);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.complaints.get(user, id);
  }

  @Get(':id/media')
  media(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.complaints.listMedia(user, id);
  }

  @Roles(...TRIAGE)
  @Get(':id/duplicate-candidates')
  duplicateCandidates(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.complaints.duplicateCandidates(user, id);
  }

  @Roles(...TRIAGE)
  @Post(':id/assign')
  assign(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: AssignDto) {
    return this.complaints.assign(user, id, dto);
  }

  @Roles(Role.WORKER, ...TRIAGE)
  @Post(':id/start')
  start(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: StartWorkDto) {
    return this.complaints.start(user, id, dto);
  }

  @Roles(Role.WORKER, ...TRIAGE)
  @Post(':id/resolve')
  resolve(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: ResolveDto) {
    return this.complaints.resolve(user, id, dto);
  }

  @Roles(...TRIAGE)
  @Post(':id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: RejectDto) {
    return this.complaints.reject(user, id, dto);
  }

  @Roles(...TRIAGE)
  @Post(':id/duplicate')
  duplicate(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: DuplicateDto) {
    return this.complaints.markDuplicate(user, id, dto);
  }

  @Roles(Role.CITIZEN)
  @Post(':id/feedback')
  feedback(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: FeedbackDto) {
    return this.complaints.feedback(user, id, dto);
  }
}
