import { AttestationController } from '@/controllers/AttestationController';
import { route } from '@/middleware/route';
import { attestationChallengeSchema } from '@/validation/auth';

export const dynamic = 'force-dynamic';
export const POST = route({ public: true, throttle: 'auth', body: attestationChallengeSchema }, AttestationController.challenge);
