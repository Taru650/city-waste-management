import type { z } from 'zod';
import { db } from '@/db/connection';
import { COOKIES, clearCookie, parseCookies, sessionCookie } from '@/middleware/http';
import { ApiResult, type Ctx } from '@/middleware/route';
import { AuthService } from '@/services/AuthService';
import { SessionService, type SessionTokens } from '@/services/SessionService';
import type {
  changePasswordSchema, forgotPasswordSchema, loginSchema, logoutSchema, preferencesSchema, refreshSchema, registerSchema, resetPasswordSchema, SessionMode,
} from '@/validation/auth';
import { unauthorized } from '@/lib/errors';

type Body<T extends z.ZodType> = z.infer<T>;
type C<T extends z.ZodType> = Ctx<Body<T>, undefined, Record<string, string>>;

/** Tokens in the response for apps; httpOnly cookies (and no tokens in the body) for the website. */
function deliver(tokens: SessionTokens, mode: SessionMode, status = 200): ApiResult {
  if (mode === 'cookie') {
    return new ApiResult(
      { status: 'OK', expiresIn: tokens.expiresIn },
      {
        status,
        cookies: [
          sessionCookie(COOKIES.access, tokens.accessToken, tokens.expiresIn),
          sessionCookie(COOKIES.refresh, tokens.refreshToken, tokens.refreshExpiresIn),
        ],
      },
    );
  }
  return new ApiResult({ status: 'OK', ...tokens }, { status });
}

const cleared = () => [clearCookie(COOKIES.access), clearCookie(COOKIES.refresh)];

export const AuthController = {
  async register({ body, client }: C<typeof registerSchema>) {
    const { session, ...input } = body;
    return deliver(await AuthService.registerCitizen(input, client), session, 201);
  },

  async login({ body, client }: C<typeof loginSchema>) {
    return deliver(await AuthService.login(body.identifier, body.password, client), body.session);
  },

  /**
   * App: send the refresh token in the body, get new tokens back.
   * Website: no body; the refresh cookie is used and replaced, and no token appears in the response
   * (so a script on the page can never read one).
   */
  async refresh({ req, body, client }: C<typeof refreshSchema>) {
    if (body.refreshToken) return deliver(await SessionService.rotate(body.refreshToken, client), 'token');
    const cookie = parseCookies(req.headers.get('cookie'))[COOKIES.refresh];
    if (!cookie) throw unauthorized();
    try {
      return deliver(await SessionService.rotate(cookie, client), 'cookie');
    } catch (err) {
      // A dead session: drop the cookies so the browser stops sending them.
      if ((err as { status?: number }).status === 401) return new ApiResult({ statusCode: 401, message: 'Unauthorized' }, { status: 401, cookies: cleared() });
      throw err;
    }
  },

  async logout({ req, body }: C<typeof logoutSchema>) {
    const token = body.refreshToken ?? parseCookies(req.headers.get('cookie'))[COOKIES.refresh];
    if (token) await SessionService.logout(token);
    return new ApiResult(null, { status: 204, cookies: cleared() });
  },

  async logoutAll({ user }: Ctx<undefined, undefined, Record<string, string>>) {
    await SessionService.revokeEverything(db(), user.id);
    return new ApiResult(null, { status: 204, cookies: cleared() });
  },

  async changePassword({ user, body, client }: C<typeof changePasswordSchema>) {
    return deliver(await AuthService.changePassword(user.id, body.currentPassword, body.newPassword, client), body.session);
  },

  async forgotPassword({ body, client }: C<typeof forgotPasswordSchema>) {
    await AuthService.forgotPassword(body.identifier, client);
    return new ApiResult({ message: 'If an account with an email exists, a reset link has been sent.' }, { status: 202 });
  },

  async resetPassword({ body, client }: C<typeof resetPasswordSchema>) {
    await AuthService.resetPassword(body.token, body.newPassword, client);
    return new ApiResult(null, { status: 204 });
  },

  me({ user }: Ctx<undefined, undefined, Record<string, string>>) {
    return AuthService.me(user.id);
  },

  setPreferences({ user, body }: C<typeof preferencesSchema>) {
    return AuthService.setPreferences(user.id, body.preferredLanguage);
  },
};
