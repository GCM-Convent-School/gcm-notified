import { BadRequestException, Body, Controller, Get, Injectable, Logger, Post, Put } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Db } from '../db/db.service';
import { FeesReportSettings, SettingsService } from '../settings/settings.service';
import { AlertsService } from '../alerts/alerts.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { addDays, atLocal, localDay, occursOn, upcoming } from '../campaigns/schedule';
import { hhmmToMinutes, localMinutes } from '../common/time';
import { feesSchedule, fmtDate, rupees } from './build';
import { OneClickService } from './oneclick.service';

const CATCH_UP_MIN = 3 * 60;   // app was down at run time: still run within 3 hours, else wait for the next scheduled day

/**
 * Scheduled fee reminders: on the chosen weekdays (or every N days) at a set time, every student with
 * outstanding fees (optionally only fees due soon) gets a reminder on the father's number.
 * The admin gets a summary after each run. Switch off from Special notifications → Fees.
 */
@Injectable()
export class FeesReportService {
  private readonly log = new Logger('FeesReport');
  private running = false;

  constructor(
    private readonly db: Db, private readonly settings: SettingsService, private readonly oneClick: OneClickService,
    private readonly alerts: AlertsService, private readonly campaigns: CampaignsService,
  ) {}

  async nextRuns(count = 3) {
    const f = (await this.settings.get()).feesReport;
    if (!f.enabled) return [];
    const today = localDay(new Date());
    const done = await this.db.one(`select 1 from fees_runs where run_day=$1 and not manual`, [today]);
    // From tomorrow when today's run is done (or its catch-up window has passed)
    const after = done || localMinutes() > hhmmToMinutes(f.time) + CATCH_UP_MIN ? new Date(atLocal(addDays(today, 1), 0).getTime() - 1) : new Date();
    return upcoming(feesSchedule(f, today), after, count, await this.campaigns.holidays()).map((r) => r.at!.toISOString());
  }

  @Interval(60_000)
  async tick() {
    const f = (await this.settings.get()).feesReport;
    if (!f.enabled || this.running) return;
    const day = localDay(new Date());
    const late = localMinutes() - hhmmToMinutes(f.time);
    if (late < 0 || late > CATCH_UP_MIN) return;
    if (!occursOn(feesSchedule(f, day), day, await this.campaigns.holidays())) return;
    if (await this.db.one(`select 1 from fees_runs where run_day=$1 and not manual`, [day])) return;
    await this.run(false).catch((e) => this.log.error((e as Error).message));
  }

  /** One run. `manual` = "Run now" from the dashboard (does not replace the scheduled run). */
  async run(manual: boolean) {
    if (this.running) throw new BadRequestException('Fee reminders are already running');
    this.running = true;
    const run = (await this.db.one<{ id: number }>(`insert into fees_runs(run_day, manual) values ($1,$2) returning id`, [localDay(new Date()), manual]))!;
    try {
      const summary = await this.doRun();
      await this.db.query(`update fees_runs set finished_at=now(), ok=true, campaign_id=$2, summary=$3 where id=$1`, [run.id, summary.campaignId, summary]);
      if (summary.students) {
        await this.alerts.send(`fees-report-${run.id}`, 'Fee reminders', [
          `Sent to ${summary.messages} fathers for ${summary.students} students — ${summary.total} outstanding${summary.dueBy ? ` (due by ${fmtDate(summary.dueBy)})` : ''}.`,
          summary.noFather ? `${summary.noFather} students have no father's number and were skipped.` : '',
          summary.notInApp ? `${summary.notInApp} students with dues are not in the app yet (run a Frappe sync).` : '',
        ].filter(Boolean).join('\n'), undefined, true);
      }
      return summary;
    } catch (e) {
      const msg = (e as Error).message;
      await this.db.query(`update fees_runs set finished_at=now(), ok=false, summary=$2 where id=$1`, [run.id, { error: msg }]);
      await this.db.event('campaign', `Fee reminders failed: ${msg}`, 'error');
      await this.alerts.send('fees-report-failed', 'Fee reminders did not send', `${msg}\nNothing was sent. The next scheduled run will try again.`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  private async doRun() {
    const s = await this.settings.get();
    const f = s.feesReport;
    const dueBy = f.dueWithinDays === null ? null : addDays(localDay(new Date()), f.dueWithinDays);
    const { students, data, notInApp } = await this.oneClick.feesData({ dueBy, minAmount: f.minAmount });
    const noFather = students.filter((st) => !st.father_phone).length;
    const total = rupees([...data.values()].reduce((a, x) => a + Number(x.vars.amount_number), 0));
    const base = { dueBy, students: data.size, noFather, notInApp, total, campaignId: null as number | null, messages: 0 };
    if (!data.size || data.size === noFather) return { ...base, students: data.size - noFather };   // nobody to remind

    const numbers = await this.db.query<{ id: number }>(`select id from wa_numbers where status='WORKING' and not paused and auto_use order by id`);
    if (!numbers.length) throw new BadRequestException('No connected WhatsApp number is available to send from');
    const label = `Fee reminder${dueBy ? ` (due by ${fmtDate(dueBy)})` : ''}`;
    const r = await this.oneClick.createCampaign({ kind: 'fees', ref: 'fees', label, template: s.oneClick.fees.template, numberIds: numbers.map((n) => n.id), data, auto: true });
    await this.db.event('campaign', `Fee reminders: ${data.size - noFather} students, ${total} outstanding (${r.total} messages)`);
    return { ...base, students: data.size - noFather, campaignId: r.campaignId, messages: r.total };
  }

  async status() {
    const s = await this.settings.get();
    const runs = await this.db.query(`select id, run_day, started_at, finished_at, ok, manual, campaign_id, summary from fees_runs order by id desc limit 10`);
    return { settings: s.feesReport, template: s.oneClick.fees.template, running: this.running, nextRuns: await this.nextRuns(), runs };
  }

  async save(b: Partial<FeesReportSettings> & { template?: string }) {
    const { template, ...patch } = b;
    const cur = await this.settings.get();
    const next = { ...cur.feesReport, ...patch };
    // "Every N days" counts from the day it is first switched on
    if (next.enabled && !next.startDate) next.startDate = localDay(new Date());
    await this.settings.update({ feesReport: next, ...(template !== undefined ? { oneClick: { ...cur.oneClick, fees: { template } } } : {}) });
    await this.db.event('settings', `Fee reminders ${next.enabled ? `on (${next.repeat === 'every' ? `every ${next.every} days` : 'weekly'} at ${next.time})` : 'off'}`);
    return this.status();
  }
}

@Controller('oneclick/fees-report')
export class FeesReportController {
  constructor(private readonly svc: FeesReportService) {}
  @Get() status() { return this.svc.status(); }
  @Put() save(@Body() b: Partial<FeesReportSettings> & { template?: string }) { return this.svc.save(b); }
  @Post('run') run() { return this.svc.run(true); }
}
