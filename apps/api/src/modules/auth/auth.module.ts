import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PiiCryptoService } from '../../common/crypto/pii-crypto.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { LogMailService, MAIL_SERVICE } from './mail.service';
import { SessionService } from './session.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService, SessionService, CaptchaService, PiiCryptoService,
    { provide: MAIL_SERVICE, useClass: LogMailService },
  ],
  exports: [JwtModule, SessionService, PiiCryptoService],
})
export class AuthModule {}
