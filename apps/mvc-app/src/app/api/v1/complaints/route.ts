import { ComplaintController } from '@/controllers/ComplaintController';
import { route } from '@/middleware/route';
import { createComplaintSchema, listComplaintsQuery } from '@/validation/complaints';

export const dynamic = 'force-dynamic';
export const GET = route({ query: listComplaintsQuery }, ComplaintController.list);
export const POST = route({ roles: ['CITIZEN'], body: createComplaintSchema }, ComplaintController.create);
