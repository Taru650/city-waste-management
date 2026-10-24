import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { Public } from './common/decorators';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AppConfigModule } from './config/config.module';
import { APP_CONFIG, AppConfig } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { ComplaintsModule } from './modules/complaints/complaints.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { JobsService } from './modules/jobs/jobs.service';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SlaModule } from './modules/sla/sla.module';
import { MastersModule } from './modules/masters/masters.module';
import { MediaModule } from './modules/media/media.module';
import { StorageModule } from './modules/storage/storage.module';
import { UsersModule } from './modules/users/users.module';

@Controller('health')
class HealthController {
  constructor(private readonly ds: DataSource, private readonly jobs: JobsService) {}

  /** Liveness: the process is up. */
  @Public() @Get()
  health() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable (load balancer / k8s readiness probe). */
  @Public() @Get('ready')
  async ready() {
    const db = await this.ds.query('SELECT 1').then(() => true, () => false);
    const redis = await this.jobs.ping();
    if (!db || !redis) throw new ServiceUnavailableException({ status: 'unavailable', db, redis });
    return { status: 'ready', db, redis };
  }
}

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => [{ name: 'default', ttl: 60_000, limit: config.rateLimitGlobalPerMin }],
    }),
    AuditModule,
    JobsModule,
    StorageModule,
    NotificationsModule,
    AuthModule,
    MediaModule,
    UsersModule,
    MastersModule,
    ComplaintsModule,
    SlaModule,
    ReportsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate-limit first, then authenticate, then authorise.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
