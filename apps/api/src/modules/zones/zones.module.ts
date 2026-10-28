import { Global, Module } from '@nestjs/common';
import { ZonesController } from './zones.controller';
import { ZonesService } from './zones.service';

@Global()
@Module({ controllers: [ZonesController], providers: [ZonesService], exports: [ZonesService] })
export class ZonesModule {}
