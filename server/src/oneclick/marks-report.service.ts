import { BadRequestException, Body, Controller, Get, Injectable, Logger, Post, Put } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Db } from '../db/db.service';
import { SettingsService, MarksReportSettings } from '../settings/settings.service';
import { AlertsService } from '../alerts/alerts.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { addDays, atLocal, localDay, weekday } from '../campaigns/schedule';
import { localMinutes, hhmmToMinutes } from '../common/time';
import { incompleteTests, periodLabel, shiftFrappeTime, testName } from './marks';
import { MarksService } from './marks.service';
import { OneClickService } from './oneclick.service';

const CATCH_UP_MIN = 3 * 60;   // app was down at run time: still run within 3 hours (later = rolls into the next run)
const HOLD_DAYS = 2;           // a half-entered test waits at most this long, then goes out (without ranks if still unfair)

/** "2026-10-31 19:00:00" in the app timezone — the format Frappe stores `creation` in (Frappe runs on the school's timezone). */
export function frappeNow(d = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).reduce<Record<string, string>>((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Daily Marks Report: at the set time on the set days, every result submitted in Frappe since the last
 * successful run goes to both parents as one statement per student. Hands-off; the admin gets a summary
 * after each run and an alert when something is wrong. Switch off from Special notifications → Marks.
 */
@Injectable()
export class MarksReportService {
  private readonly log = new Logger('MarksReport');
  private running = false;

  constructor(
    private readonly db: Db, private readonly settings: SettingsService, private readonly marks: MarksService,
    private readonly oneClick: OneClickService, private readonly alerts: AlertsService, private readonly campaigns: CampaignsService,
  ) {}

  /** Whether `day` is a sending day, and the minute of the day it runs at. */
  private async runsOn(s: MarksReportSettings, day: string, holidays?: Set<string>) {
    if (!s.days.includes(weekday(day))) return false;
    return !(s.skipHolidays && (holidays ?? await this.campaigns.holidays()).has(day));
  }

  async nextRuns(count = 3) {
    const s = (await this.settings.get()).marksReport;
    if (!s.enabled) return [];
    const holidays = await this.campaigns.holidays();
    const out: string[] = [];
    const today = localDay(new Date());
    const doneToday = await this.db.one(`select 1 from marks_runs where run_day=$1 and not manual`, [today]);
    for (let i = 0, day = today; i < 30 && out.length < count; i++, day = addDays(day, 1)) {
      if (!(await this.runsOn(s, day, holidays))) continue;
      if (day === today && (doneToday || localMinutes() > hhmmToMinutes(s.time) + CATCH_UP_MIN)) continue;
      out.push(atLocal(day, hhmmToMinutes(s.time)).toISOString());
    }
    return out;
  }

  @Interval(60_000)
  async tick() {
    const s = (await this.settings.get()).marksReport;
    if (!s.enabled || this.running) return;
    const day = localDay(new Date());
    const late = localMinutes() - hhmmToMinutes(s.time);
    if (late < 0 || late > CATCH_UP_MIN || !(await this.runsOn(s, day))) return;
    if (await this.db.one(`select 1 from marks_runs where run_day=$1 and not manual`, [day])) return;
    await this.run(false).catch((e) => this.log.error((e as Error).message));
  }

  /** One run. `manual` = "Run now" from the dashboard (same rules, does not replace today's scheduled run). */
  async run(manual: boolean) {
    if (this.running) throw new BadRequestException('The report is already running');
    this.running = true;
    const run = (await this.db.one<{ id: number }>(`insert into marks_runs(run_day, manual) values ($1,$2) returning id`, [localDay(new Date()), manual]))!;
    try {
      const summary = await this.doRun(run.id);
      await this.db.query(`update marks_runs set finished_at=now(), ok=true, watermark=$2, campaign_id=$3, summary=$4 where id=$1`,
        [run.id, summary.watermark, summary.campaignId, summary]);
      await this.report(summary);
      return summary;
    } catch (e) {
      const msg = (e as Error).message;
      await this.db.query(`update marks_runs set finished_at=now(), ok=false, summary=$2 where id=$1`, [run.id, { error: msg }]);
      await this.db.event('campaign', `Daily Marks Report failed: ${msg}`, 'error');
      await this.alerts.send('marks-report-failed', 'Daily Marks Report did not send', `${msg}\nNothing was sent. Marks will go out with the next successful run.`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  private async doRun(runId: number) {
    const s = (await this.settings.get()).marksReport;
    await this.marks.checkTimezone();
    const last = await this.db.one<{ watermark: string }>(`select watermark from marks_runs where ok and watermark is not null order by id desc limit 1`);
    // A day of overlap catches results saved while the last run was reading; marks_sent stops doubles
    const since = last ? shiftFrappeTime(last.watermark, -1) : s.startFrom || frappeNow(new Date(Date.now() - 86_400_000));
    const held = (await this.db.query<{ plan: string; first_seen_at: Date }>('select plan, first_seen_at from marks_held'));
    const fresh = await this.marks.results([['creation', '>', since]]);
    const heldResults = held.length ? await this.marks.resultsOfPlans(held.map((h) => h.plan)) : [];
    const candidates = [...new Map([...fresh, ...heldResults].map((r) => [r.name, r])).values()];
    const watermark = [last?.watermark ?? '', ...fresh.map((r) => r.creation.slice(0, 19))].sort().pop() || frappeNow();

    const sent = new Set((await this.db.query<{ result_name: string }>('select result_name from marks_sent where result_name = any($1)',
      [candidates.flatMap((r) => [r.name, r.amended_from ?? ''])])).map((r) => r.result_name));
    // A correction of a result that already went out is reported to the admin, not re-sent to parents
    const corrections = candidates.filter((r) => !sent.has(r.name) && r.amended_from && sent.has(r.amended_from));
    for (const r of corrections) {
      await this.db.query(`insert into marks_sent(result_name, plan, run_id) values ($1,$2,$3) on conflict do nothing`, [r.name, r.assessment_plan, runId]);
    }
    const isCorrection = new Set(corrections.map((r) => r.name));
    let items = candidates.filter((r) => !sent.has(r.name) && !isCorrection.has(r.name));

    // Half-entered tests wait (at most HOLD_DAYS) so ranks are not computed on a partial class
    const plans = [...new Set(items.map((r) => r.assessment_plan))];
    const cohort = await this.marks.withDates(await this.marks.resultsOfPlans(plans));
    const incomplete = incompleteTests(cohort, await this.marks.sectionSizes(), s.rules.minEnteredPct);
    const firstSeen = new Map(held.map((h) => [h.plan, h.first_seen_at]));
    const holding = new Map<string, { name: string; section: string; entered: number; size: number }>();
    for (const [plan, t] of incomplete) {
      const seen = firstSeen.get(plan);
      if (seen && Date.now() - seen.getTime() > HOLD_DAYS * 86_400_000) continue;
      if (!seen) await this.db.query(`insert into marks_held(plan) values ($1) on conflict do nothing`, [plan]);
      holding.set(plan, t);
    }
    const dated = new Map(cohort.map((r) => [r.name, r]));
    items = items.filter((r) => !holding.has(r.assessment_plan)).map((r) => dated.get(r.name) ?? r);
    const releasing = [...new Set(items.map((r) => r.assessment_plan))];
    if (releasing.length) await this.db.query(`delete from marks_held where plan = any($1)`, [releasing]);

    const days = items.map((r) => r.creation.slice(0, 10)).sort();
    const period = days.length ? periodLabel(days[0], days[days.length - 1], 'added') : '';
    const { data, notInApp } = await this.marks.statements(items, cohort, period);
    const base = {
      since, watermark, students: data.size, results: items.length, notInApp, campaignId: null as number | null, messages: 0,
      tests: [...new Set(items.map((r) => `${testName(r)} (${r.student_group ?? ''})`))].sort(),
      held: [...holding.values()].map((h) => `${h.name} (${h.section}): ${h.entered}/${h.size} entered`),
      corrections: corrections.map((r) => `${r.student_name ?? r.student} — ${testName(r)} (${r.student_group ?? ''}) now ${Number(r.total_score ?? 0)}/${Number(r.maximum_score ?? 0)}`),
    };
    if (!data.size) return base;   // no marks → no messages

    const numbers = await this.db.query<{ id: number }>(`select id from wa_numbers where status='WORKING' and not paused and auto_use order by id`);
    if (!numbers.length) throw new BadRequestException('No connected WhatsApp number is available to send from');
    const r = await this.oneClick.createCampaign({ kind: 'marks', ref: 'daily', label: 'Daily marks report', template: s.template, numberIds: numbers.map((n) => n.id), data, auto: true });
    await this.marks.recordSent(data, r.campaignId, runId);
    await this.db.event('campaign', `Daily Marks Report: ${data.size} students, ${base.tests.length} tests (${r.total} messages)`);
    return { ...base, campaignId: r.campaignId, messages: r.total };
  }

  /** Admin summary after a run — only when something was sent, held back or corrected. */
  private async report(x: Awaited<ReturnType<MarksReportService['doRun']>>) {
    if (!x.students && !x.held.length && !x.corrections.length) return;
    const lines = [
      x.students ? `Sent for ${x.students} students (${x.messages} messages), ${x.tests.length} test${x.tests.length === 1 ? '' : 's'}.` : 'No new marks to send.',
      x.notInApp ? `${x.notInApp} students with marks are not in the app yet (run a Frappe sync).` : '',
      x.held.length ? `Held back (marks look half-entered):\n${x.held.map((h) => `• ${h}`).join('\n')}` : '',
      x.corrections.length ? `Changed after parents were told (not re-sent):\n${x.corrections.map((c) => `• ${c}`).join('\n')}` : '',
    ].filter(Boolean);
    await this.alerts.send(`marks-report-${Date.now()}`, 'Daily Marks Report', lines.join('\n\n'), undefined, true);
  }

  async status() {
    const s = (await this.settings.get()).marksReport;
    const runs = await this.db.query(`select id, run_day, started_at, finished_at, ok, manual, campaign_id, summary from marks_runs order by id desc limit 10`);
    const held = await this.db.query(`select plan, first_seen_at from marks_held order by first_seen_at`);
    return { settings: s, running: this.running, nextRuns: await this.nextRuns(), runs, held: held.length };
  }

  async save(patch: Partial<MarksReportSettings>) {
    const cur = await this.settings.get();
    const next = { ...cur.marksReport, ...patch };
    // First switch-on: start from now, so years of old marks are not sent
    if (next.enabled && !next.startFrom) next.startFrom = frappeNow();
    await this.settings.update({ marksReport: next });
    await this.db.event('settings', `Daily Marks Report ${next.enabled ? `on (${next.time})` : 'off'}`);
    return this.status();
  }
}

@Controller('oneclick/marks-report')
export class MarksReportController {
  constructor(private readonly svc: MarksReportService) {}
  @Get() status() { return this.svc.status(); }
  @Put() save(@Body() b: Partial<MarksReportSettings>) { return this.svc.save(b); }
  @Post('run') run() { return this.svc.run(true); }
}
