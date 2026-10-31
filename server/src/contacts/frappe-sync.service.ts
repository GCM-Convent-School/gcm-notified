import { BadRequestException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { config, frappeConfigured } from '../config';
import { Db } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { normalizePhone } from '../common/phone';

export class FrappeAccessError extends Error {
  constructor(readonly doctype: string) {
    super(`Frappe ${doctype} → HTTP 403: the GCM Notified API user is not allowed to read "${doctype}" yet. Give its role read permission on ${doctype} in Frappe.`);
  }
}

const CLASS_ORDER = ['PRE-NURSERY', 'NURSERY', 'LKG', 'UKG', '1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH', '8TH', '9TH', '10TH', '11TH', '12TH'];

@Injectable()
export class FrappeSyncService implements OnApplicationBootstrap {
  private readonly log = new Logger('FrappeSync');
  private running = false;

  constructor(private readonly db: Db, private readonly settings: SettingsService) {}

  onApplicationBootstrap() {
    // First sync shortly after boot if never synced
    setTimeout(async () => {
      const last = await this.db.one('select 1 from sync_runs where ok limit 1');
      if (!last && frappeConfigured()) this.sync().catch((e) => this.log.error(e.message));
    }, 10_000);
  }

  @Interval(15 * 60_000)
  async scheduled() {
    if (!frappeConfigured()) return;
    const every = (await this.settings.get()).frappe.syncEveryHours;
    const last = await this.db.one<{ started_at: Date }>('select started_at from sync_runs where ok order by id desc limit 1');
    if (!last || Date.now() - last.started_at.getTime() > every * 3600_000) await this.sync().catch((e) => this.log.error(e.message));
  }

  /** Reads a doctype from Frappe (all rows). Used by the sync and by 1-Click notifications. */
  async get<T = any>(doctype: string, fields: string[], filters?: unknown[]): Promise<T[]> {
    const q = new URLSearchParams({ fields: JSON.stringify(fields), limit_page_length: '0' });
    if (filters) q.set('filters', JSON.stringify(filters));
    const res = await fetch(`${config.frappeUrl}/api/resource/${encodeURIComponent(doctype)}?${q}`, {
      headers: { Authorization: `token ${config.frappeApiKey}:${config.frappeApiSecret}`, Accept: 'application/json' },
    });
    if (res.status === 403) throw new FrappeAccessError(doctype);
    if (!res.ok) throw new Error(`Frappe ${doctype} → HTTP ${res.status}`);
    return ((await res.json()) as { data: T[] }).data;
  }

  /** Frappe's own timezone — `creation` timestamps are stored in it. */
  async timezone(): Promise<string> {
    const res = await fetch(`${config.frappeUrl}/api/method/frappe.client.get_time_zone`, {
      headers: { Authorization: `token ${config.frappeApiKey}:${config.frappeApiSecret}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Frappe timezone → HTTP ${res.status}`);
    return ((await res.json()) as { message: { time_zone: string } }).message.time_zone;
  }

  async status() {
    const last = await this.db.one('select * from sync_runs order by id desc limit 1');
    return { configured: frappeConfigured(), running: this.running, last };
  }

  async sync() {
    if (!frappeConfigured()) throw new BadRequestException('Frappe is not configured (FRAPPE_URL / FRAPPE_API_KEY / FRAPPE_API_SECRET)');
    if (this.running) throw new BadRequestException('A sync is already running');
    this.running = true;
    const run = await this.db.one<{ id: number }>('insert into sync_runs default values returning id');
    try {
      const summary = await this.doSync();
      await this.db.query('update sync_runs set finished_at=now(), ok=true, summary=$2 where id=$1', [run!.id, summary]);
      await this.db.event('sync', `Frappe sync: ${summary.students} students, ${summary.groups} classes, ${summary.subgroups} sections`);
      return summary;
    } catch (e) {
      await this.db.query('update sync_runs set finished_at=now(), ok=false, summary=$2 where id=$1', [run!.id, { error: (e as Error).message }]);
      await this.db.event('sync', `Frappe sync failed: ${(e as Error).message}`, 'error');
      throw e;
    } finally {
      this.running = false;
    }
  }

  private async doSync() {
    const s = (await this.settings.get()).frappe;
    const exclude = new Set(s.excludePrograms.map((p) => p.trim().toLowerCase()));

    // Academic year: setting, else the year with the most submitted enrolments
    // (more reliable than dates — two years can carry the same start date in Frappe)
    const enrol = await this.get<any>('Program Enrollment', ['student', 'program', 'academic_year'], [['docstatus', '=', 1]]);
    let year = s.academicYear;
    if (!year) {
      const counts = new Map<string, number>();
      for (const e of enrol) if (e.academic_year) counts.set(e.academic_year, (counts.get(e.academic_year) ?? 0) + 1);
      year = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    }

    const students = await this.get<any>('Student', [
      'name', 'custom_admission_number', 'student_name', 'custom_father_mobile_number', 'custom_mother_mobile_number', 'student_mobile_number', 'date_of_birth',
    ], [['enabled', '=', 1]]);

    // Guardian names + numbers (fallback when the student-level fields are empty)
    const guardians = new Map<string, string | null>(
      (await this.get<any>('Guardian', ['name', 'mobile_number'])).map((g) => [g.name, g.mobile_number]),
    );
    const links = await this.get<any>('Student', ['name', 'guardians.guardian', 'guardians.guardian_name', 'guardians.relation']);
    const parentInfo = new Map<string, { father?: { name: string; phone: string | null }; mother?: { name: string; phone: string | null } }>();
    for (const l of links) {
      if (!l.guardian) continue;
      const rel = String(l.relation ?? '').toLowerCase();
      const key = rel === 'father' ? 'father' : rel === 'mother' ? 'mother' : null;
      if (!key) continue;
      const cur = parentInfo.get(l.name) ?? {};
      cur[key] ??= { name: l.guardian_name, phone: guardians.get(l.guardian) ?? null };
      parentInfo.set(l.name, cur);
    }

    // Section membership for the academic year
    const sgRows = await this.get<any>('Student Group', ['name', 'program', 'academic_year', 'disabled', 'students.student', 'students.active'], [['disabled', '=', 0]]);
    const sectionOf = new Map<string, { section: string; program: string }>();
    for (const r of sgRows) {
      if (year && r.academic_year && r.academic_year !== year) continue;
      if (!r.student || r.active === 0) continue;
      if (!sectionOf.has(r.student)) sectionOf.set(r.student, { section: r.name, program: r.program });
    }
    // Program fallback from enrolments
    const programOf = new Map<string, string>();
    for (const e of enrol) if (!year || e.academic_year === year) programOf.set(e.student, e.program);

    let groups = 0, subgroups = 0, count = 0;
    const seenGroupKeys = new Set<string>();
    await this.db.tx(async (c) => {
      const groupId = async (key: string, name: string, parent: number | null, order: number) => {
        seenGroupKeys.add(key);
        const r = await c.query(
          `insert into contact_groups(source, source_key, name, parent_id, sort_order) values ('frappe',$1,$2,$3,$4)
           on conflict (source_key) do update set name=excluded.name, parent_id=excluded.parent_id, sort_order=excluded.sort_order
           returning id, (xmax = 0) as inserted`,
          [key, name, parent, order],
        );
        return r.rows[0].id as number;
      };
      const programIds = new Map<string, number>();
      const sectionIds = new Map<string, number>();

      await c.query('update students set active=false');
      for (const st of students) {
        const sec = sectionOf.get(st.name);
        const program = sec?.program ?? programOf.get(st.name) ?? null;
        if (!program || exclude.has(program.toLowerCase())) continue;
        if (!st.custom_admission_number) continue;

        let pid = programIds.get(program);
        if (pid === undefined) {
          const idx = CLASS_ORDER.indexOf(program.toUpperCase());
          pid = await groupId(`program:${program}`, program, null, idx >= 0 ? idx : 100);
          programIds.set(program, pid); groups++;
        }
        const sectionName = sec?.section ?? `${program} – Unassigned`;
        const skey = sec ? `sg:${sec.section}` : `unassigned:${program}`;
        let sid = sectionIds.get(skey);
        if (sid === undefined) {
          sid = await groupId(skey, sectionName, pid, sec ? 0 : 999);
          sectionIds.set(skey, sid); subgroups++;
        }
        const p = parentInfo.get(st.name) ?? {};
        await c.query(
          `insert into students(frappe_id, admission_no, student_name, program, section, group_id, father_name, mother_name, father_phone, mother_phone, student_phone, dob, active, synced_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,now())
           on conflict (frappe_id) do update set admission_no=excluded.admission_no, student_name=excluded.student_name, program=excluded.program,
             section=excluded.section, group_id=excluded.group_id, father_name=excluded.father_name, mother_name=excluded.mother_name,
             father_phone=excluded.father_phone, mother_phone=excluded.mother_phone, student_phone=excluded.student_phone, dob=excluded.dob, active=true, synced_at=now()`,
          [st.name, String(st.custom_admission_number).trim(), st.student_name, program, sec?.section ?? null, sid,
           p.father?.name ?? null, p.mother?.name ?? null,
           normalizePhone(st.custom_father_mobile_number) ?? normalizePhone(p.father?.phone),
           normalizePhone(st.custom_mother_mobile_number) ?? normalizePhone(p.mother?.phone),
           normalizePhone(st.student_mobile_number), /^\d{4}-\d{2}-\d{2}$/.test(String(st.date_of_birth ?? '')) ? st.date_of_birth : null],
        );
        count++;
      }
      // Remove Frappe groups that no longer exist
      const keys = [...seenGroupKeys];
      await c.query(`delete from contact_groups where source='frappe' and parent_id is not null and not (source_key = any($1))`, [keys]);
      await c.query(`delete from contact_groups where source='frappe' and parent_id is null and not (source_key = any($1))`, [keys]);
    });

    const missing = await this.db.one<{ n: number }>(`select count(*)::int n from students where active and father_phone is null and mother_phone is null`);
    return { academicYear: year, students: count, groups, subgroups, missingNumbers: missing?.n ?? 0, holidays: await this.syncHolidays() };
  }

  /** School holidays from Frappe's Holiday List (weekly offs left out — sending days cover those). Needs read permission. */
  private async syncHolidays(): Promise<number | string> {
    try {
      const rows = await this.get<any>('Holiday List', ['name', 'holidays.holiday_date', 'holidays.description', 'holidays.weekly_off']);
      const days = rows.filter((r) => r.holiday_date && !r.weekly_off);
      await this.db.tx(async (c) => {
        await c.query(`delete from holidays where source='frappe'`);
        for (const d of days) {
          await c.query(`insert into holidays(day, name, source) values ($1,$2,'frappe') on conflict (day) do nothing`,
            [d.holiday_date, String(d.description ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 120) || null]);
        }
      });
      return days.length;
    } catch (e) {
      return e instanceof FrappeAccessError ? 'no access' : `failed: ${(e as Error).message}`;
    }
  }
}
