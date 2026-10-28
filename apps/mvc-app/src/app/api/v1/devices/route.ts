import { MediaController } from '@/controllers/MediaController';
import { route } from '@/middleware/route';
import { registerDeviceSchema } from '@/validation/media';

export const dynamic = 'force-dynamic';
/** Only the mobile apps capture evidence; the website never uploads media. */
const CAPTURING = ['CITIZEN', 'WORKER', 'SUPERVISOR', 'SUB_ADMIN'] as const;
// Device keys secure the account (sign-in registers one before the privacy-notice screen appears).
export const GET = route({ roles: [...CAPTURING], allowWithoutConsent: true }, MediaController.listDevices);
export const POST = route({ roles: [...CAPTURING], allowWithoutConsent: true, body: registerDeviceSchema }, MediaController.registerDevice);
