import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { Db } from './db/db.service';
import { AuthController, AuthGuard } from './auth/auth';
import { WahaClient } from './waha/waha.client';
import { SettingsService } from './settings/settings.service';
import { SettingsController } from './settings/settings.controller';
import { AlertsService } from './alerts/alerts.service';
import { NumbersService } from './numbers/numbers.service';
import { NumbersController } from './numbers/numbers.controller';
import { FrappeSyncService } from './contacts/frappe-sync.service';
import { ContactsController } from './contacts/contacts.controller';
import { PeopleService } from './contacts/people.service';
import { MediaController } from './media/media.controller';
import { CampaignsService } from './campaigns/campaigns.service';
import { CampaignsController, TemplatesController } from './campaigns/campaigns.controller';
import { SenderService } from './sender/sender.service';
import { SchedulerService } from './campaigns/scheduler.service';
import { WebhooksController } from './webhooks/webhooks.controller';
import { ApiKeysController, ApiService, PublicApiController } from './api/public-api';
import { WaCheckService } from './contacts/wa-check.service';
import { OneClickController, OneClickService } from './oneclick/oneclick.service';
import { MarksService } from './oneclick/marks.service';
import { MarksReportController, MarksReportService } from './oneclick/marks-report.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [
    AuthController, SettingsController, NumbersController, ContactsController, MediaController,
    CampaignsController, TemplatesController, WebhooksController, PublicApiController, ApiKeysController, OneClickController, MarksReportController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    Db, WahaClient, SettingsService, AlertsService, NumbersService, FrappeSyncService, PeopleService, CampaignsService, SchedulerService, SenderService,
    ApiService, WaCheckService, OneClickService, MarksService, MarksReportService,
  ],
})
export class AppModule {}
