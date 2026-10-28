import { ReportController } from '@/controllers/ReportController';
import { route } from '@/middleware/route';
import { ageingQuery } from '@/validation/reports';

export const dynamic = 'force-dynamic';
export const GET = route({ roles: ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN', 'SUPERVISOR'], query: ageingQuery }, ReportController.ageing);
