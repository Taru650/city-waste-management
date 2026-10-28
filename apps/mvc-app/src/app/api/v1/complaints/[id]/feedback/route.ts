import { ComplaintController } from '@/controllers/ComplaintController';
import { route } from '@/middleware/route';
import { feedbackSchema } from '@/validation/complaints';

export const dynamic = 'force-dynamic';
export const POST = route({ roles: ['CITIZEN'], body: feedbackSchema }, ComplaintController.feedback);
