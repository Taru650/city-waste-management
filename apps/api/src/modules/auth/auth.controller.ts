import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../../common/auth-user';
import { Client } from '../../common/client-info';
import { AllowPendingPasswordChange, CurrentUser, Public } from '../../common/decorators';
import { AuthThrottle } from '../../common/throttle';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import {
  ChangePasswordDto, ForgotPasswordDto, LoginDto, MfaCodeDto, MfaRecoverDto, MfaTokenDto, PreferencesDto, RefreshDto, RegisterCitizenDto,
  ResetPasswordDto, TotpCodeDto,
} from './dto/auth.dto';
import { ClientInfo, SessionService } from './session.service';

/**
 * One auth API for every client. Mobile apps keep tokens in secure storage; the
 * Next.js portal keeps them in httpOnly cookies on its own server and calls this
 * API with the same Bearer token.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly captcha: CaptchaService,
  ) {}

  @Public() @AuthThrottle()
  @Post('register')
  async register(@Body() dto: RegisterCitizenDto, @Client() client: ClientInfo) {
    await this.captcha.assertHuman(dto.captchaToken, client.ip ?? '');
    return this.auth.registerCitizen(dto, client);
  }

  @Public() @AuthThrottle()
  @Post('login') @HttpCode(200)
  login(@Body() dto: LoginDto, @Client() client: ClientInfo) {
    return this.auth.login(dto, client);
  }

  @Public() @AuthThrottle()
  @Post('mfa/enroll') @HttpCode(200)
  mfaEnroll(@Body() dto: MfaTokenDto) {
    return this.auth.mfaEnroll(dto.mfaToken);
  }

  @Public() @AuthThrottle()
  @Post('mfa/activate') @HttpCode(200)
  mfaActivate(@Body() dto: MfaCodeDto, @Client() client: ClientInfo) {
    return this.auth.mfaActivate(dto.mfaToken, dto.code, client);
  }

  @Public() @AuthThrottle()
  @Post('mfa/verify') @HttpCode(200)
  mfaVerify(@Body() dto: MfaCodeDto, @Client() client: ClientInfo) {
    return this.auth.mfaVerify(dto.mfaToken, dto.code, client);
  }

  @Public() @AuthThrottle()
  @Post('mfa/recover') @HttpCode(200)
  mfaRecover(@Body() dto: MfaRecoverDto, @Client() client: ClientInfo) {
    return this.auth.mfaRecover(dto.mfaToken, dto.recoveryCode, client);
  }

  @ApiBearerAuth() @AuthThrottle()
  @Post('mfa/recovery-codes') @HttpCode(200)
  regenerateRecoveryCodes(@CurrentUser() user: AuthUser, @Body() dto: TotpCodeDto, @Client() client: ClientInfo) {
    return this.auth.regenerateRecoveryCodes(user.id, dto.code, client);
  }

  @ApiBearerAuth() @AllowPendingPasswordChange()
  @Patch('me/preferences')
  preferences(@CurrentUser() user: AuthUser, @Body() dto: PreferencesDto) {
    return this.auth.setPreferences(user.id, dto.preferredLanguage);
  }

  @Public() @AuthThrottle()
  @Post('refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Client() client: ClientInfo) {
    return this.sessions.rotate(dto.refreshToken, client);
  }

  @Public()
  @Post('logout') @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.sessions.revokeFamily(dto.refreshToken);
  }

  @ApiBearerAuth() @AllowPendingPasswordChange()
  @Post('logout-all') @HttpCode(204)
  async logoutAll(@CurrentUser() user: AuthUser) {
    await this.sessions.revokeAll(user.id);
  }

  @ApiBearerAuth() @AllowPendingPasswordChange() @AuthThrottle()
  @Post('change-password') @HttpCode(200)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @Client() client: ClientInfo) {
    return this.auth.changePassword(user.id, dto, client);
  }

  @Public() @AuthThrottle()
  @Post('forgot-password') @HttpCode(202)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Client() client: ClientInfo) {
    await this.captcha.assertHuman(dto.captchaToken, client.ip ?? '');
    await this.auth.forgotPassword(dto.identifier, client);
    return { message: 'If an account with an email exists, a reset link has been sent.' };
  }

  @Public() @AuthThrottle()
  @Post('reset-password') @HttpCode(204)
  async resetPassword(@Body() dto: ResetPasswordDto, @Client() client: ClientInfo) {
    await this.auth.resetPassword(dto, client);
  }

  @ApiBearerAuth() @AllowPendingPasswordChange()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}
