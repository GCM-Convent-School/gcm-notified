import { BadRequestException, Injectable } from '@nestjs/common';
import { Db } from '../db/db.service';
import { frappeConfigured } from '../config';
import { FrappeAccessError, FrappeSyncService } from '../contacts/frappe-sync.service';
import { SettingsService } from '../settings/settings.service';
import { StudentRow } from '../campaigns/render';
import { buildStatements, periodLabel, Result, testName } from './marks';
import { StudentVars } from './build';

const FIELDS = ['name', 'student', 'student_name', 'assessment_plan', 'assessment_group', 'course', 'student_group', 'program',
  'total_score', 'maximum_score', 'creation', 'amended_from', 'comment'];
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export interface TestFilter { from?: string; to?: string; dateField?: 'added' | 'held'; groupIds?: number[]; types?: string[] }
export interface Statement extends StudentVars { results: { name: string; plan: string }[] }

/** Frappe marks → statements for students in the app. Shared by manual 1-Click marks and the Daily Marks Report. */
@Injectable()
export class MarksService {
  constructor(private readonly db: Db, private readonly frappe: FrappeSyncService, private readonly settings: SettingsService) {}

  async frappeGet<T>(doctype: string, fields: string[], filters?: unknown[]): Promise<T[]> {
    if (!frappeConfigured()) throw new BadRequestException('Frappe is not configured (FRAPPE_URL / FRAPPE_API_KEY / FRAPPE_API_SECRET)');
    try { return await this.frappe.get<T>(doctype, fields, filters); } catch (e) {
      throw new BadRequestException(e instanceof FrappeAccessError
        ? `GCM Notified can't read "${e.doctype}" in Frappe yet. Ask the Frappe admin to give the API user's role read permission on ${e.doctype}.`
        : (e as Error).message);
    }
  }

  /** Submitted results matching extra Frappe filters. */
  results(filters: unknown[]): Promise<Result[]> {
    return this.frappeGet<Result>('Assessment Result', FIELDS, [['docstatus', '=', 1], ...filters]);
  }

  /** Every submitted result of these tests (the ranking cohort), fetched in chunks. */
  async resultsOfPlans(plans: string[]): Promise<Result[]> {
    const out: Result[] = [];
    for (let i = 0; i < plans.length; i += 100) out.push(...await this.results([['assessment_plan', 'in', plans.slice(i, i + 100)]]));
    return out;
  }

  /**
   * Test date per Assessment Plan, or null when the API user may not read Assessment Plan
   * (then everything still works, just without test dates).
   */
  async planDates(plans: string[]): Promise<Map<string, string> | null> {
    const out = new Map<string, string>();
    try {
      for (let i = 0; i < plans.length; i += 100) {
        const rows = await this.frappe.get<{ name: string; schedule_date: string | null }>('Assessment Plan', ['name', 'schedule_date'], [['name', 'in', plans.slice(i, i + 100)]]);
        for (const r of rows) if (r.schedule_date) out.set(r.name, r.schedule_date);
      }
      return out;
    } catch (e) {
      if (e instanceof FrappeAccessError) return null;
      throw e;
    }
  }

  /** Adds the test date to each result (when readable). */
  async withDates(results: Result[]): Promise<Result[]> {
    const dates = await this.planDates([...new Set(results.map((r) => r.assessment_plan))]);
    return dates ? results.map((r) => ({ ...r, held_on: dates.get(r.assessment_plan) ?? null })) : results;
  }

  /** Stops early when Frappe's clock is not the app's: "added since" and "added on" would be off by hours. */
  async checkTimezone() {
    const tz = await this.frappe.timezone();
    const app = process.env.APP_TIMEZONE || 'Asia/Kolkata';
    if (tz !== app) throw new BadRequestException(`Frappe runs on ${tz} but the app is set to ${app} (APP_TIMEZONE) — marks dates would be wrong. Make them match.`);
  }

  /** Section (Frappe student group) → active students in the app. */
  async sectionSizes(): Promise<Map<string, number>> {
    const rows = await this.db.query<{ section: string; n: number }>(`select section, count(*)::int n from students where active and section is not null group by section`);
    return new Map(rows.map((r) => [r.section, r.n]));
  }

  /** Sections inside the chosen classes/sections (empty = whole school). */
  private async sectionsOf(groupIds: number[]): Promise<Set<string> | null> {
    const ids = groupIds.map(Number).filter(Number.isFinite);
    if (!ids.length) return null;
    const rows = await this.db.query<{ section: string }>(
      `select distinct s.section from students s join contact_groups g on g.id = s.group_id
       where s.active and s.section is not null and (g.id = any($1) or g.parent_id = any($1))`, [ids]);
    return new Set(rows.map((r) => r.section));
  }

  private async resultsFor(f: TestFilter): Promise<Result[]> {
    const from = isDay(f.from) ? f.from : null, to = isDay(f.to) ? f.to : from;
    if (!from || !to) throw new BadRequestException('Choose the dates');
    if (to < from) throw new BadRequestException('The end date is before the start date');
    if (f.dateField === 'held') {
      const plans = await this.frappeGet<{ name: string }>('Assessment Plan', ['name'], [['docstatus', '=', 1], ['schedule_date', 'between', [from, to]]]);
      return plans.length ? this.resultsOfPlans(plans.map((p) => p.name)) : [];
    }
    return this.results([['creation', 'between', [`${from} 00:00:00`, `${to} 23:59:59.999999`]]]);
  }

  /** The tests matching the filters, for the picker: one row per test (a test belongs to one section). */
  async tests(f: TestFilter) {
    const [found, sections, sizes] = await Promise.all([this.resultsFor(f), this.sectionsOf(f.groupIds ?? []), this.sectionSizes()]);
    const inClasses = found.filter((r) => !sections || sections.has(r.student_group ?? ''));
    const types = [...new Set(inClasses.map((r) => r.assessment_group).filter(Boolean) as string[])].sort();
    const want = new Set(f.types ?? []);
    const plans = [...new Set(inClasses.filter((r) => !want.size || want.has(r.assessment_group ?? '')).map((r) => r.assessment_plan))];
    // Counts use the whole test, not only the part that falls inside the dates
    const all = await this.resultsOfPlans(plans);
    const dates = await this.planDates(plans);
    const sent = new Map((await this.db.query<{ plan: string; n: number }>(
      `select plan, count(*)::int n from marks_sent where plan = any($1) group by plan`, [plans])).map((r) => [r.plan, r.n]));
    const by = new Map<string, Result[]>();
    for (const r of all) by.set(r.assessment_plan, [...(by.get(r.assessment_plan) ?? []), r]);
    const tests = [...by.entries()].map(([plan, list]) => {
      const first = list[0];
      const added = list.map((r) => r.creation).sort();
      return {
        plan, name: testName(first), course: first.course ?? '', type: first.assessment_group ?? '', class: first.program ?? '', section: first.student_group ?? '',
        heldOn: dates?.get(plan) ?? null, results: list.length, size: sizes.get(first.student_group ?? '') ?? 0, sent: sent.get(plan) ?? 0,
        addedFrom: added[0].slice(0, 10), addedTo: added[added.length - 1].slice(0, 10),
      };
    }).sort((a, b) => b.addedTo.localeCompare(a.addedTo) || a.section.localeCompare(b.section) || a.name.localeCompare(b.name));
    return { tests, types, testDates: dates !== null };
  }

  /**
   * Statements for students in the app. `items` = what goes in the messages; `cohort` = every result of those tests (for ranks).
   * Returns local student id → statement, plus how many Frappe students are not in the app.
   */
  async statements(items: Result[], cohort: Result[], period: string, groupIds: number[] = []) {
    const s = (await this.settings.get()).marksReport;
    const byFrappe = buildStatements({ items, cohort, sectionSizes: await this.sectionSizes(), rules: s.rules, lines: s.lines, period });
    const ids = groupIds.map(Number).filter(Number.isFinite);
    const students = await this.db.query<StudentRow & { frappe_id: string }>(
      `select s.* from students s join contact_groups g on g.id = s.group_id
       where s.active and s.frappe_id = any($1) and (cardinality($2::int[]) = 0 or g.id = any($2) or g.parent_id = any($2))
       order by s.program, s.section, s.student_name`, [[...byFrappe.keys()], ids]);
    const plan = new Map(items.map((r) => [r.name, r.assessment_plan]));
    const data = new Map<number, Statement>();
    for (const st of students) {
      const v = byFrappe.get(st.frappe_id)!;
      data.set(st.id, { summary: v.summary, vars: v.vars, results: v.results.map((name) => ({ name, plan: plan.get(name)! })) });
    }
    return { students, data, notInApp: ids.length ? 0 : byFrappe.size - students.length };
  }

  /** Manual: chosen tests → statements (results already sent are left out unless `includeSent`). */
  async forTests(b: { plans?: string[]; includeSent?: boolean; groupIds?: number[] } & TestFilter) {
    const plans = [...new Set((b.plans ?? []).map(String))];
    if (!plans.length) throw new BadRequestException('Tick at least one test');
    const cohort = await this.withDates(await this.resultsOfPlans(plans));
    const sent = new Set((await this.db.query<{ result_name: string }>('select result_name from marks_sent where plan = any($1)', [plans])).map((r) => r.result_name));
    const items = b.includeSent ? cohort : cohort.filter((r) => !sent.has(r.name));
    // "Marks added": the dates the marks really went in, not the whole search range
    const added = (items.length ? items : cohort).map((r) => r.creation.slice(0, 10)).sort();
    const period = b.dateField === 'held' && isDay(b.from) ? periodLabel(b.from, isDay(b.to) ? b.to : b.from, 'held')
      : added.length ? periodLabel(added[0], added[added.length - 1], 'added') : 'Marks';
    return { ...(await this.statements(items, cohort, period, b.groupIds ?? [])), period, alreadySent: cohort.length - items.length };
  }

  async recordSent(data: Map<number, Statement>, campaignId: number | null, runId: number | null) {
    for (const [studentId, st] of data) {
      for (const r of st.results) {
        await this.db.query(`insert into marks_sent(result_name, plan, student_id, campaign_id, run_id) values ($1,$2,$3,$4,$5) on conflict (result_name) do nothing`,
          [r.name, r.plan, studentId, campaignId, runId]);
      }
    }
  }
}
