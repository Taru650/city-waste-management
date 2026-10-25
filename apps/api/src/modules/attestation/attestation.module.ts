import { Global, Module } from '@nestjs/common';
import { AttestationController } from './attestation.controller';
import { AttestationService } from './attestation.service';

@Global()
@Module({ controllers: [AttestationController], providers: [AttestationService], exports: [AttestationService] })
export class AttestationModule {}
