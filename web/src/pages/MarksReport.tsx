import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { Badge, Card, Field, Toggle, useLoad, useToast } from '../components/ui';
import { ListPicker } from './CampaignEditor';
import type { GroupNode } from './Contacts';

interface ReportSettings {
  enabled: boolean; time: string; days: number[]; skipHolidays: boolean; startFrom: string;
  rules: { minRanked: number; minEnteredPct: number; topPct: number };
  lines: { rankLine: string; bottomLine: string };
  template: string;
}
interface Run {
  id: number; run_day: string; started_at: string; ok: boolean | null; manual: boolean; campaign_id: number | null;
  summary: { students?: number; messages?: number; tests?: string[]; held?: string[]; corrections?: string[]; notInApp?: number; error?: string } | null;
}
interface Status { settings: ReportSettings; running: boolean; nextRuns: string[]; runs: Run[]; held: number }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const today = () => new Date().toLocaleDateString('en-CA');

/** Daily Marks Report: on/off, when it runs, rank rules and the message — plus the last runs. */
export function DailyMarksReport() {
  const toast = useToast();
  const st = useLoad(() => api.get<Status>('/oneclick/marks-report'), [], 30_000);
  const [draft, setDraft] = useState<ReportSettings | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (st.data && !draft) setDraft(st.data.settings); }, [st.data]);
  if (!st.data || !draft) return <Card title="📊 Daily Marks Report"><p className="text-sm text-slate-500">{st.error ?? 'Loading…'}</p></Card>;

  const saved = st.data.settings;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (p: Partial<ReportSettings>) => setDraft({ ...draft, ...p });
  const save = async (patch: Partial<ReportSettings>, msg: string) => {
    setBusy(true);
    try { const r = await api.put<Status>('/oneclick/marks-report', patch); st.setData(r); setDraft(r.settings); toast(msg); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const toggle = (on: boolean) => {
    if (on && !confirm(`Turn on the Daily Marks Report?\n\nEvery day at ${draft.time} (${draft.days.map((d) => DAYS[d]).join(', ')}), marks added in Frappe since the last run go to both parents. It starts with marks added from now on.`)) return;
    save({ ...draft, enabled: on }, on ? 'Daily Marks Report is on' : 'Daily Marks Report is off — nothing more will be sent');
  };
  const runNow = async () => {
    if (!confirm('Send everything added since the last run now? This does not replace the scheduled run.')) return;
    setBusy(true);
    try { const r = await api.post('/oneclick/marks-report/run'); toast(r.students ? `Sending for ${r.students} students (${r.messages} messages)` : 'No new marks to send'); st.reload(); }
    catch (e) { toast((e as Error).message, 'error'); st.reload(); } finally { setBusy(false); }
  };
  const last = st.data.runs[0];

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">📊 Daily Marks Report</h2>
            <Badge tone={saved.enabled ? 'green' : 'slate'}>{saved.enabled ? 'On' : 'Off'}</Badge>
            {st.data.running && <Badge tone="amber">Running…</Badge>}
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Marks added in Frappe since the last run go to <b>both parents</b> as one message per student, with the daily class rank when it is fair.
            You get a summary on WhatsApp after each run.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {saved.enabled ? <>Next: {st.data.nextRuns.length ? st.data.nextRuns.map((d) => fmtDate(d)).join(' · ') : 'no sending day in the next month'}</> : 'Off — nothing is sent automatically.'}
            {last && <> · Last run {fmtDate(last.started_at)}: {last.ok === false ? <span className="text-red-600">failed — {last.summary?.error}</span> : last.summary?.students ? `${last.summary.students} students` : 'no new marks'}</>}
            {st.data.held > 0 && <> · <span className="text-amber-700">{st.data.held} test{st.data.held === 1 ? '' : 's'} held back</span></>}
          </p>
        </div>
        <div className="pt-1"><Toggle checked={saved.enabled} onChange={toggle} label={saved.enabled ? 'On' : 'Off'} /></div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[auto_1fr_auto]">
        <Field label="Start sending at"><input type="time" className="input w-32" value={draft.time} onChange={(e) => set({ time: e.target.value })} /></Field>
        <div>
          <span className="label">On these days</span>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => {
              const on = draft.days.includes(i);
              return <button key={d} type="button" onClick={() => set({ days: on ? draft.days.filter((x) => x !== i) : [...draft.days, i].sort() })}
                className={`rounded-lg border px-2.5 py-1.5 text-sm ${on ? 'border-brand-600 bg-brand-50 font-medium text-brand-800' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>{d}</button>;
            })}
          </div>
          <div className="mt-2"><Toggle checked={draft.skipHolidays} onChange={(v) => set({ skipHolidays: v })} label="Skip school holidays" hint="Holidays from Frappe and Settings. Marks from a skipped day go in the next run." /></div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button className="btn-secondary" disabled={busy || st.data.running} onClick={runNow}>Run now</button>
          <button className="btn-ghost text-xs" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Rank rules & message'} {open ? '▴' : '▾'}</button>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">Sending stops at quiet hours and continues in the morning. Pacing follows the 📝 Academic message type.</p>

      {open && (
        <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Rank only if ≥ students" hint="ranked in the section"><input type="number" className="input" min={2} value={draft.rules.minRanked} onChange={(e) => set({ rules: { ...draft.rules, minRanked: Number(e.target.value) } })} /></Field>
              <Field label="…and ≥ % of section" hint="else no rank line"><input type="number" className="input" min={0} max={100} value={draft.rules.minEnteredPct} onChange={(e) => set({ rules: { ...draft.rules, minEnteredPct: Number(e.target.value) } })} /></Field>
              <Field label="Show rank to top %" hint="the rest get the note"><input type="number" className="input" min={1} max={100} value={draft.rules.topPct} onChange={(e) => set({ rules: { ...draft.rules, topPct: Number(e.target.value) } })} /></Field>
            </div>
            <Field label={`Rank line (top ${draft.rules.topPct}%)`} hint={<>Fields: <code>{'{{rank}}'}</code> <code>{'{{of}}'}</code> <code>{'{{section}}'}</code> <code>{'{{first_name}}'}</code></>}>
              <input className="input" value={draft.lines.rankLine} onChange={(e) => set({ lines: { ...draft.lines, rankLine: e.target.value } })} />
            </Field>
            <Field label={`Note instead of rank (bottom ${100 - draft.rules.topPct}%)`} hint="No rank number is ever shown to this group.">
              <textarea className="input h-20" value={draft.lines.bottomLine} onChange={(e) => set({ lines: { ...draft.lines, bottomLine: e.target.value } })} />
            </Field>
            <p className="text-xs text-slate-500">A student absent (0) in any of the tests gets their marks but no rank line. Equal scores share a rank.</p>
          </div>
          <Field label="Message" hint={<>Fields: <code>{'{{period}}'}</code> <code>{'{{marks}}'}</code> <code>{'{{total}}'}</code> <code>{'{{max}}'}</code> <code>{'{{percent}}'}</code> <code>{'{{rank_line}}'}</code> <code>{'{{student_name}}'}</code> <code>{'{{section}}'}</code>. Also used by manual marks below.</>}>
            <textarea className="input h-64 font-mono text-[13px]" value={draft.template} onChange={(e) => set({ template: e.target.value })} />
          </Field>
        </div>
      )}
      {dirty && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <button className="btn-ghost" onClick={() => setDraft(saved)}>Undo changes</button>
          <button className="btn-primary" disabled={busy} onClick={() => save(draft, 'Saved')}>Save</button>
        </div>
      )}

      {st.data.runs.length > 0 && (
        <details className="mt-4 border-t border-slate-100 pt-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">Last runs</summary>
          <table className="table mt-2">
            <thead><tr><th>When</th><th>Result</th><th>Tests</th><th>Held back / changed</th><th /></tr></thead>
            <tbody>{st.data.runs.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap text-xs">{fmtDate(r.started_at)}{r.manual && <div className="text-slate-500">run now</div>}</td>
                <td>{r.ok === null ? <Badge tone="amber">running</Badge> : !r.ok ? <span className="text-xs text-red-600">{r.summary?.error}</span>
                  : r.summary?.students ? <span className="text-sm">{r.summary.students} students · {r.summary.messages} msgs</span> : <span className="text-xs text-slate-500">no new marks</span>}</td>
                <td className="text-xs text-slate-600">{r.summary?.tests?.join(', ') || '—'}</td>
                <td className="text-xs text-amber-700">{[...(r.summary?.held ?? []), ...(r.summary?.corrections ?? []).map((c) => `changed: ${c}`)].join(' · ') || '—'}</td>
                <td>{r.campaign_id && <Link to={`/campaigns/${r.campaign_id}`} className="text-xs text-brand-700 hover:underline">report →</Link>}</td>
              </tr>))}</tbody>
          </table>
        </details>
      )}
    </Card>
  );
}

// ---------- manual: pick tests ----------
interface Test { plan: string; heldOn: string | null; name: string; course: string; type: string; class: string; section: string; results: number; size: number; sent: number; addedFrom: string; addedTo: string }
export interface MarksPick { plans: string[]; includeSent: boolean; from: string; to: string; dateField: 'added' | 'held'; groupIds: number[] }

/** Classes → dates (marks added / test held) → test types → tick tests. */
export function MarksPicker({ tree, minPct, onChange }: { tree: GroupNode[]; minPct: number; onChange: (p: MarksPick) => void }) {
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [dateField, setDateField] = useState<'added' | 'held'>('added');
  const [found, setFound] = useState<{ tests: Test[]; types: string[]; testDates: boolean } | null>(null);
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [plans, setPlans] = useState<Set<string>>(new Set());
  const [includeSent, setIncludeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const find = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.post<{ tests: Test[]; types: string[]; testDates: boolean }>('/oneclick/marks/tests', { from, to, dateField, groupIds });
      setFound(r); setTypes(new Set());
      setPlans(new Set(r.tests.filter((t) => t.sent < t.results).map((t) => t.plan)));
    } catch (e) { setError((e as Error).message); setFound(null); } finally { setLoading(false); }
  };
  const shown = useMemo(() => (found?.tests ?? []).filter((t) => !types.size || types.has(t.type)), [found, types]);
  const picked = shown.filter((t) => plans.has(t.plan)).map((t) => t.plan);
  useEffect(() => { onChange({ plans: picked, includeSent, from, to, dateField, groupIds }); }, [picked.join(','), includeSent, from, to, dateField, groupIds.join(',')]);
  const flip = (p: string) => setPlans((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-3">
          <span className="label">Classes (empty = whole school)</span>
          <ListPicker tree={tree} ids={groupIds} onChange={setGroupIds} />
        </div>
        <Field label="From"><input type="date" className="input" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} /></Field>
        <Field label="To"><input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        <div>
          <span className="label">Dates mean</span>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
            {([['added', 'Marks added'], ['held', 'Test held']] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setDateField(k)} className={`flex-1 rounded-md px-2 py-1 ${dateField === k ? 'bg-white font-medium shadow-sm' : 'text-slate-600'}`}>{l}</button>))}
          </div>
        </div>
      </div>
      <button className="btn-secondary" disabled={loading} onClick={find}>{loading ? 'Looking in Frappe…' : found ? '↻ Find tests again' : 'Find tests'}</button>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}
        {error.includes('Assessment Plan') && <p className="mt-1 text-xs">"Test held" needs Frappe → Role Permission Manager → Assessment Plan → role <b>GCM Notified Reader</b> → <b>Read</b>. "Marks added" works without it.</p>}</div>}

      {found && (!found.tests.length ? <p className="text-sm text-slate-500">No tests with marks for these dates and classes.</p> : (
        <div className="space-y-2">
          {found.types.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-slate-500">Type:</span>
              {found.types.map((t) => (
                <button key={t} type="button" onClick={() => setTypes((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; })}
                  className={`rounded-full px-3 py-1 text-xs ${types.has(t) ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{t}</button>))}
            </div>
          )}
          {!found.testDates && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Test dates are not shown: in Frappe, give the role <b>GCM Notified Reader</b> <b>Read</b> on <b>Assessment Plan</b> (Role Permission Manager). This also turns on "Test held".
            </p>
          )}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">{picked.length} of {shown.length} tests ticked</span>
            <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setPlans(new Set([...plans, ...shown.map((t) => t.plan)]))}>Tick all</button>
            <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setPlans(new Set([...plans].filter((p) => !shown.some((t) => t.plan === p))))}>Clear</button>
          </div>
          <div className="max-h-72 overflow-auto rounded-lg border border-slate-100">
            <table className="table">
              <thead className="sticky top-0 bg-white"><tr><th className="w-8" /><th>Test</th><th>Section</th>{found.testDates && <th>Test date</th>}<th>Marks entered</th><th>Added</th><th>Sent</th></tr></thead>
              <tbody>{shown.map((t) => {
                const partial = t.size > 0 && t.results * 100 < t.size * minPct;
                return (
                  <tr key={t.plan} className="cursor-pointer" onClick={() => flip(t.plan)}>
                    <td><input type="checkbox" checked={plans.has(t.plan)} onChange={() => flip(t.plan)} onClick={(e) => e.stopPropagation()} aria-label={`Tick ${t.name}`} /></td>
                    <td><div className="font-medium">{t.course || t.name}</div><div className="text-xs text-slate-500">{t.type}</div></td>
                    <td className="text-xs">{t.section}</td>
                    {found.testDates && <td className="text-xs">{t.heldOn ?? '—'}</td>}
                    <td className="text-sm tabular-nums">{t.results}{t.size ? `/${t.size}` : ''} {partial && <Badge tone="amber">incomplete — no ranks</Badge>}</td>
                    <td className="text-xs text-slate-500">{t.addedFrom === t.addedTo ? t.addedFrom : `${t.addedFrom} → ${t.addedTo}`}</td>
                    <td>{t.sent ? <Badge tone={t.sent >= t.results ? 'green' : 'amber'}>{t.sent >= t.results ? 'sent' : `${t.sent} sent`}</Badge> : <span className="text-xs text-slate-400">—</span>}</td>
                  </tr>);
              })}</tbody>
            </table>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeSent} onChange={(e) => setIncludeSent(e.target.checked)} />
            Include marks already sent <span className="text-xs text-slate-500">(a full statement; otherwise parents only get what they have not had yet)</span></label>
        </div>
      ))}
    </div>
  );
}
