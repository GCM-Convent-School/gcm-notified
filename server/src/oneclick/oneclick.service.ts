import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Post } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Db } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { checkTemplate, phonesFor, RecipientMode, renderMessage, StudentRow, studentRecipients } from '../campaigns/render';
import { buildFees, fmtDate, rupees, StudentVars } from './build';
import { localDay } from '../campaigns/schedule';
import { MarksService, Statement, TestFilter } from './marks.service';

type Kind = 'marks' | 'fees';
const TYPE: Record<Kind, 'academic' | 'fees'> = { marks: 'academic', fees: 'fees' };

// Marks go to both parents (the same number twice gets one message); fee reminders only to the father
const MODE: Record<Kind, RecipientMode> = { marks: 'both', fees: 'father' };

interface Fetched {
  kind: Kind; ref: string; label: string; at: number;
  data: Map<number, StudentVars | Statement>;   // local student id → variables (marks: + the Frappe results in it)
}
interface FetchBody extends TestFilter { kind: Kind; plans?: string[]; includeSent?: boolean; groupIds?: number[]; dueBy?: string | null; minAmount?: number }

export interface FeesFilter { groupIds?: number[]; dueBy?: string | null; minAmount?: number }

export interface CampaignSpec {
  kind: Kind; ref: string; label: string; template: string; numberIds: number[];
  data: Map<number, StudentVars>;
  auto?: boolean;                    // sent by a schedule (Daily Marks Report / fee reminders), not by hand
}

/**
 * Special notifications: fetch marks / pending fees from Frappe, review who gets what, send.
 * A fetch is kept for 30 minutes so the send uses exactly the data that was reviewed.
 */
@Injectable()
export class OneClickService {
  private fetched = new Map<string, Fetched>();

  constructor(
    private readonly db: Db, private readonly marks: MarksService, private readonly settings: SettingsService, private readonly campaigns: CampaignsService,
  ) {}

  /** Who a kind goes to: marks both parents, fees the father. Pacing and quiet hours come from the message type. */
  private async mode(kind: Kind) {
    const s = await this.settings.get();
    const type = await this.settings.builtInType(TYPE[kind]);
    return { s, type, mode: MODE[kind] };
  }

  /** Outstanding fees from Frappe → one entry per student in the app. Shared by the manual screen and the fee reminder schedule. */
  async feesData(b: FeesFilter) {
    const rows = await this.marks.frappeGet<any>('Fees',
      ['name', 'student', 'outstanding_amount', 'grand_total', 'due_date', 'academic_term', 'fee_structure', 'fee_schedule', 'posting_date'],
      [['docstatus', '=', 1], ['outstanding_amount', '>', 0]]);
    const byFrappe = buildFees(rows, { dueBy: b.dueBy || null, minAmount: Number(b.minAmount) || 0 });
    // Match to students in the app (synced from Frappe), optionally only some classes
    const ids = (b.groupIds ?? []).map(Number).filter(Number.isFinite);
    const students = await this.db.query<StudentRow & { frappe_id: string }>(
      `select s.* from students s join contact_groups g on g.id = s.group_id
       where s.active and s.frappe_id = any($1) and (cardinality($2::int[]) = 0 or g.id = any($2) or g.parent_id = any($2))
       order by s.program, s.section, s.student_name`, [[...byFrappe.keys()], ids]);
    const data = new Map<number, StudentVars>(students.map((st) => [st.id, byFrappe.get(st.frappe_id)!]));
    return { students, data, notInApp: ids.length ? 0 : byFrappe.size - students.length };
  }

  /** Fetches from Frappe and returns one row per student with what they would get. */
  async fetch(b: FetchBody) {
    const kind: Kind = b.kind === 'fees' ? 'fees' : 'marks';
    let students: StudentRow[], data: Map<number, StudentVars | Statement>, notInApp: number, ref: string, label: string;
    let alreadySent = 0;
    if (kind === 'marks') {
      const r = await this.marks.forTests(b);
      ({ students, data, notInApp, alreadySent } = r);
      ref = 'statement';
      label = r.period;
    } else {
      ({ students, data, notInApp } = await this.feesData(b));
      ref = 'fees';
      label = `Fee reminder${b.dueBy ? ` (due by ${fmtDate(b.dueBy)})` : ''}`;
    }

    const { s, type, mode } = await this.mode(kind);
    const opted = new Set((await this.db.query<{ phone: string }>('select phone from opt_outs')).map((r) => r.phone));
    const phones = students.flatMap((x) => [x.father_phone, x.mother_phone, x.student_phone]).filter(Boolean) as string[];
    const wa = new Map((await this.db.query<{ phone: string; on_whatsapp: boolean }>('select phone, on_whatsapp from phone_checks where phone = any($1)', [phones])).map((r) => [r.phone, r.on_whatsapp]));
    // Marks: when any of these results went out before (only possible with "include already sent")
    const last = new Map(kind === 'marks'
      ? (await this.db.query<{ student_id: number; created_at: Date }>(
        `select student_id, max(created_at) created_at from marks_sent where result_name = any($1) group by student_id`,
        [[...data.values()].flatMap((v) => (v as Statement).results.map((r) => r.name))])).map((r) => [r.student_id, { created_at: r.created_at, summary: '' }])
      : (await this.db.query<{ student_id: number; created_at: Date; summary: string }>(
        `select distinct on (student_id) student_id, created_at, summary from oneclick_log where kind=$1 and ref=$2 order by student_id, created_at desc`,
        [kind, ref])).map((r) => [r.student_id, r]));

    const recentDays = kind === 'fees' ? 3 : 0;
    const rows = students.map((st) => {
      const v = data.get(st.id)!;
      const to = phonesFor(st, mode, s.primaryParent).map((p) => ({
        relation: p.relation, phone: p.phone, optedOut: opted.has(p.phone), wa: wa.get(p.phone) ?? null,
      }));
      const reachable = to.filter((p) => !p.optedOut && p.wa !== false);
      const status = !to.length ? 'no_number' : !reachable.length ? (to.every((p) => p.optedOut) ? 'opted_out' : 'not_on_whatsapp') : 'ready';
      const prev = last.get(st.id) ?? null;
      const recently = !!prev && Date.now() - prev.created_at.getTime() < recentDays * 86_400_000;
      return {
        id: st.id, name: st.student_name, admission_no: st.admission_no, class: st.program, section: st.section,
        summary: v.summary, to, status, lastSent: prev ? { at: prev.created_at, summary: prev.summary } : null,
        selected: status === 'ready' && !recently,
      };
    });

    const fetchId = randomBytes(9).toString('base64url');
    this.prune();
    this.fetched.set(fetchId, { kind, ref, label, at: Date.now(), data });
    const total = kind === 'fees' ? rupees([...data.values()].reduce((a, x) => a + Number(x.vars.amount_number), 0)) : null;
    return {
      fetchId, kind, label, fetchedAt: new Date(), rows, notInApp, total, alreadySent,
      type: { key: type.key, name: type.name, icon: type.icon, school: mode },
      template: kind === 'marks' ? s.marksReport.template : s.oneClick.fees.template,
    };
  }

  private prune() {
    for (const [k, f] of this.fetched) if (Date.now() - f.at > 30 * 60_000) this.fetched.delete(k);
  }
  private get(fetchId: string) {
    const f = this.fetched.get(fetchId);
    if (!f) throw new NotFoundException('This list has expired — fetch again from Frappe');
    return f;
  }

  /** The message one student's parent would get. */
  async render(b: { fetchId: string; studentId: number; template: string }) {
    const f = this.get(b.fetchId);
    const v = f.data.get(Number(b.studentId));
    if (!v) throw new NotFoundException('Student not in this list');
    const st = await this.db.one<StudentRow>('select * from students where id=$1', [b.studentId]);
    const { s, mode } = await this.mode(f.kind);
    const r = studentRecipients([{ ...st!, csv: v.vars as any }], mode, s.primaryParent, true).recipients[0];
    try { checkTemplate(b.template); } catch (e) { throw new BadRequestException((e as Error).message); }
    // No usable number: still preview with the student's details (the parent name stays empty)
    const vars = r?.vars ?? { student_name: st!.student_name, first_name: st!.student_name.split(/\s+/)[0], admission_no: st!.admission_no,
      class: st!.program ?? '', section: st!.section ?? '', father_name: st!.father_name ?? '', mother_name: st!.mother_name ?? '', parent_name: '', ...v.vars };
    return { to: r?.display ?? `${st!.student_name} (no number)`, text: renderMessage(b.template, vars) };
  }

  /** Creates the campaign (type Academic / Fees), launches it, and remembers who was notified. */
  async send(b: { fetchId: string; studentIds: number[]; template: string; numberIds: number[]; saveTemplate?: boolean }) {
    const f = this.get(b.fetchId);
    const ids = [...new Set((b.studentIds ?? []).map(Number))].filter((id) => f.data.has(id));
    if (!ids.length) throw new BadRequestException('Select at least one student');
    const template = String(b.template ?? '').trim();
    if (!template) throw new BadRequestException('The message is empty');
    try { checkTemplate(template); } catch (e) { throw new BadRequestException((e as Error).message); }
    if (!(b.numberIds ?? []).length) throw new BadRequestException('Choose at least one number to send from');

    if (b.saveTemplate) {
      const s = await this.settings.get();
      await this.settings.update(f.kind === 'marks' ? { marksReport: { ...s.marksReport, template } } : { oneClick: { ...s.oneClick, fees: { template } } });
    }
    const data = new Map(ids.map((id) => [id, f.data.get(id)!]));
    const r = await this.createCampaign({ kind: f.kind, ref: f.ref, label: f.label, template, numberIds: b.numberIds, data });
    if (f.kind === 'marks') await this.marks.recordSent(data as Map<number, Statement>, r.campaignId, null);
    await this.db.event('campaign', `Special notification: ${f.label} sent for ${data.size} students`);
    return r;
  }

  /** Creates the campaign (type Academic / Fees), one row per student with their variables, and launches it. */
  async createCampaign(spec: CampaignSpec) {
    const { type, mode } = await this.mode(spec.kind);
    const known = await this.settings.messageType(type.key);
    const name = `${type.icon} ${spec.label} · ${fmtDate(localDay(new Date()))}`;
    const c = await this.campaigns.create({ name, kind: 'contacts' });
    await this.campaigns.update(c!.id, {
      ...(known ? { message_type: type.key } : { respect_quiet_hours: type.quietHours }),
      recipient_mode: mode, body: spec.template, number_ids: spec.numberIds, per_child: true,
    });
    const students = await this.db.query<{ id: number; admission_no: string }>('select id, admission_no from students where id = any($1)', [[...spec.data.keys()]]);
    const columns = [...new Set(students.flatMap((x) => Object.keys(spec.data.get(x.id)!.vars)))];
    await this.db.tx(async (tx) => {
      let i = 0;
      for (const st of students) {
        await tx.query('insert into campaign_rows(campaign_id, row_no, key_value, data, student_id, matched) values ($1,$2,$3,$4,$5,true)',
          [c!.id, ++i, st.admission_no, JSON.stringify(spec.data.get(st.id)!.vars), st.id]);
      }
      const csv = { filename: `Frappe · ${spec.label}`, keyColumn: 'admission_no', keyType: 'admission', nameColumn: null, columns, variables: columns, rows: students.length, matched: students.length, unmatched: 0 };
      await tx.query(`update campaigns set audience = $2 where id=$1`, [c!.id, JSON.stringify({ csv, oneClick: { kind: spec.kind, ref: spec.ref, label: spec.label, auto: !!spec.auto } })]);
    });
    const launched = await this.campaigns.launch(c!.id, false);
    for (const st of students) {
      await this.db.query('insert into oneclick_log(kind, ref, student_id, campaign_id, summary) values ($1,$2,$3,$4,$5)',
        [spec.kind, spec.ref, st.id, c!.id, spec.data.get(st.id)!.summary]);
    }
    return { campaignId: c!.id, total: launched.total };
  }

  /** Every marks / fees send (scheduled or by hand), plus scheduled runs that sent nothing or failed. Newest first. */
  history() {
    return this.db.query(
      `select * from (
         select 'campaign' as row, id, id as campaign_id, name, status, total, sent, delivered, read, failed, skipped, created_at,
                audience->'oneClick'->>'kind' as kind, coalesce((audience->'oneClick'->>'auto')::boolean, false) as auto, null::jsonb as summary
         from campaigns where audience ? 'oneClick'
         union all
         select 'run', id, null, 'Daily Marks Report', case when ok then 'nothing to send' when ok is null then 'running' else 'failed' end,
                0, 0, 0, 0, 0, 0, started_at, 'marks', true, summary
         from marks_runs where campaign_id is null
         union all
         select 'run', id, null, 'Fee reminders', case when ok then 'nothing to send' when ok is null then 'running' else 'failed' end,
                0, 0, 0, 0, 0, 0, started_at, 'fees', true, summary
         from fees_runs where campaign_id is null
       ) h order by created_at desc limit 30`);
  }
}

@Controller('oneclick')
export class OneClickController {
  constructor(private readonly oc: OneClickService, private readonly marks: MarksService) {}
  @Post('marks/tests') tests(@Body() b: TestFilter) { return this.marks.tests(b); }
  @Post('fetch') fetch(@Body() b: FetchBody) { return this.oc.fetch(b); }
  @Post('render') render(@Body() b: any) { return this.oc.render(b); }
  @Post('send') send(@Body() b: any) { return this.oc.send(b); }
  @Get('history') history() { return this.oc.history(); }
}
