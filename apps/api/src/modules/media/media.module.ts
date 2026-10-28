import { Global, Module } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { MalwareScanner } from './malware-scanner';
import { MediaController } from './media.controller';
import { MediaProcessor } from './media-processor';
import { MediaService } from './media.service';

@Global()
@Module({
  controllers: [MediaController],
  providers: [MediaService, DevicesService, MediaProcessor, MalwareScanner],
  exports: [MediaService],
})
export class MediaModule {}
