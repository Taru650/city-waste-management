import { Module } from '@nestjs/common';
import { ComplaintsModule } from '../complaints/complaints.module';
import { SlaService } from './sla.service';

@Module({ imports: [ComplaintsModule], providers: [SlaService], exports: [SlaService] })
export class SlaModule {}
