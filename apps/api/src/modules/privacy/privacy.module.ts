import { Global, Module } from '@nestjs/common';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';

@Global()
@Module({ controllers: [PrivacyController], providers: [PrivacyService], exports: [PrivacyService] })
export class PrivacyModule {}
