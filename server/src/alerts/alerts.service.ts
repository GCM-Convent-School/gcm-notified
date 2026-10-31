import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { config, smtpConfigured } from '../config';
import { Db } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { WahaClient } from '../waha/waha.client';
import { normalizePhone, toChatId } from '../common/phone';

@Injectable()
export class AlertsService {
  private readonly log = new Logger('Alerts');
  private lastSent = new Map<string, number>();

  constructor(private readonly db: Db, private readonly settings: SettingsService, private readonly waha: WahaClient) {}

  /**
   * Sends an alert by email and WhatsApp (from a connected number other than `excludeNumberId`).
   * The same `key` is not re-sent within 30 minutes. `info` = a routine report rather than a warning.
   */
  async send(key: string, subject: string, text: string, excludeNumberId?: number, info = false) {
    const now = Date.now();
    if ((this.lastSent.get(key) ?? 0) > now - 30 * 60_000) return;
    this.lastSent.set(key, now);

    await this.db.event('alert', `${subject} — ${text}`, info ? 'info' : 'warn');
    const s = (await this.settings.get()).alerts;
    const results: string[] = [];

    if (s.emailEnabled && s.email && smtpConfigured()) {
      try {
        await this.mailer().sendMail({ from: config.smtp.from || config.smtp.user, to: s.email, subject: `[GCM Notified] ${subject}`, text });
        results.push('email');
      } catch (e) {
        this.log.error(`Email alert failed: ${(e as Error).message}`);
      }
    }

    const admin = normalizePhone(s.adminPhone);
    if (s.whatsapp && admin) {
      const from = await this.db.one<{ session: string }>(
        `select session from wa_numbers where status = 'WORKING' and not paused and ($1::int is null or id <> $1) order by id limit 1`,
        [excludeNumberId ?? null],
      );
      if (from) {
        try {
          await this.waha.sendText(from.session, toChatId(admin), `${info ? '📊' : '⚠️'} *${subject}*\n${text}`);
          results.push(`whatsapp via ${from.session}`);
        } catch (e) {
          this.log.error(`WhatsApp alert failed: ${(e as Error).message}`);
        }
      }
    }
    this.log[info ? 'log' : 'warn'](`ALERT ${subject} → ${results.join(', ') || 'no channel available'}`);
  }

  async test() {
    this.lastSent.delete('test');
    await this.send('test', 'Test alert', 'This is a test alert from GCM Notified. If you received this, alerts are working.');
  }

  private transporter?: Transporter;
  private mailer() {
    this.transporter ??= nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
    return this.transporter;
  }
}
