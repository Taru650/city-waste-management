import type { z } from 'zod';
import { ApiResult, type Ctx } from '@/middleware/route';
import { PrivacyService } from '@/services/PrivacyService';
import type { consentSchema, correctProfileSchema, erasureSchema } from '@/validation/privacy';

type P = Record<string, string>;
const noContent = () => new ApiResult(null, { status: 204 });

export const PrivacyController = {
  notice: () => PrivacyService.notice(),
  consent: ({ user, body }: Ctx<z.infer<typeof consentSchema>, undefined, P>) => PrivacyService.consent(user, body),
  myData: ({ user }: Ctx<undefined, undefined, P>) => PrivacyService.export(user),
  async correct({ user, body }: Ctx<z.infer<typeof correctProfileSchema>, undefined, P>) {
    await PrivacyService.correct(user, body);
    return noContent();
  },
  async erase({ user, body, client }: Ctx<z.infer<typeof erasureSchema>, undefined, P>) {
    await PrivacyService.erase(user, body.password, client.ip);
    return noContent();
  },
};
