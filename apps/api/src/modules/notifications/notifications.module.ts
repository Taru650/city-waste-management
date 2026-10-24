import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushSender } from './push-sender';

@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationsService, PushSender], exports: [NotificationsService] })
export class NotificationsModule {}
