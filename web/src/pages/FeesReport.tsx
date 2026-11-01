import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { Badge, Card, Field, Toggle, useLoad, useToast } from '../components/ui';

interface FeesSettings {
  enabled: boolean; time: string; repeat: 'weekly' | 'every'; days: number[]; every: number; startDate: string;
  skipHolidays: boolean; dueWithinDays: number | null; minAmount: number;
}
interface Run {
  id: number; started_at: string; ok: boolean | null; manual: boolean; campaign_id: number | null;
  summary: { students?: number; messages?: number; total?: string; noFather?: number; notInApp?: number; dueBy?: string | null; error?: string } | null;
}
interface Status { settings: FeesSettings; template: string; running: boolean; nextRuns: string[]; runs: Run[] }
type Draft = FeesSettings & { template: string };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const when = (f: FeesSettings) => f.repeat === 'every' ? `every ${f.every} day${f.every === 1 ? '' : 's'}` : `every ${f.days.map((d) => DAYS[d]).join(', ') || '—'}`;

/** Scheduled fee reminders: on/off, weekly days or every N days, which fees, the message — plus the last runs. */
export function FeesReminders() {
  const toast = useToast();
  const st = useLoad(() => api.get<Status>('/oneclick/fees-report'), [], 30_000);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (st.data && !draft) setDraft({ ...st.data.settings, template: st.data.template }); }, [st.data]);
  if (!st.data || !draft) return <Card title="💰 Fee reminders"><p className="text-sm text-slate-500">{st.error ?? 'Loading…'}</p></Card>;

  const saved: Draft = { ...st.data.settings, template: st.data.template };
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  const save = async (body: Partial<Draft>, msg: string) => {
    setBusy(true);
    try { const r = await api.put<Status>('/oneclick/fees-report', body); st.setData(r); setDraft({ ...r.settings, template: r.template }); toast(msg); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const toggle = (on: boolean) => {
    if (on && !confirm(`Turn on fee reminders?\n\n${when(draft)} at ${draft.time}, every student with ${draft.dueWithinDays === null ? 'outstanding fees' : `fees due within ${draft.dueWithinDays} days`} gets a reminder on the father's number.`)) return;
    save({ ...draft, enabled: on }, on ? 'Fee reminders are on' : 'Fee reminders are off — nothing more will be sent');
  };
  const runNow = async () => {
    if (!confirm("Send fee reminders to fathers now, with these settings? This does not replace the scheduled run.")) return;
    setBusy(true);
    try { const r = await api.post('/oneclick/fees-report/run'); toast(r.students ? `Reminding ${r.students} students' fathers (${r.messages} messages)` : 'Nobody to remind'); st.reload(); }
    catch (e) { toast((e as Error).message, 'error'); st.reload(); } finally { setBusy(false); }
  };
  const last = st.data.runs[0];
  const s = st.data.settings;

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">💰 Fee reminders</h2>
            <Badge tone={s.enabled ? 'green' : 'slate'}>{s.enabled ? 'On' : 'Off'}</Badge>
            {st.data.running && <Badge tone="amber">Running…</Badge>}
          </div>
          <p className="mt-1 text-sm text-slate-600">
            On schedule, every student with pending fees in Frappe gets a reminder on the <b>father's number</b> (students without one are skipped).
            You get a summary on WhatsApp after each run.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {s.enabled ? <>Next: {st.data.nextRuns.length ? st.data.nextRuns.map((d) => fmtDate(d)).join(' · ') : 'no run in the next months'}</> : 'Off — nothing is sent automatically.'}
            {last && <> · Last run {fmtDate(last.started_at)}: {last.ok === false ? <span className="text-red-600">failed — {last.summary?.error}</span> : last.summary?.students ? `${last.summary.students} students, ${last.summary.total}` : 'nobody to remind'}</>}
          </p>
        </div>
        <div className="pt-1"><Toggle checked={s.enabled} onChange={toggle} label={s.enabled ? 'On' : 'Off'} /></div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[auto_1fr_auto]">
        <Field label="Send at"><input type="time" className="input w-32" value={draft.time} onChange={(e) => set({ time: e.target.value })} /></Field>
        <div>
          <span className="label">Repeat</span>
          <div className="mb-2 flex w-fit gap-1 rounded-lg bg-slate-100 p-1 text-sm">
            {([['weekly', 'Weekly, on days'], ['every', 'Every N days']] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => set({ repeat: k })} className={`rounded-md px-3 py-1 ${draft.repeat === k ? 'bg-white font-medium shadow-sm' : 'text-slate-600'}`}>{l}</button>))}
          </div>
          {draft.repeat === 'weekly' ? (
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => {
                const on = draft.days.includes(i);
                return <button key={d} type="button" onClick={() => set({ days: on ? draft.days.filter((x) => x !== i) : [...draft.days, i].sort() })}
                  className={`rounded-lg border px-2.5 py-1.5 text-sm ${on ? 'border-brand-600 bg-brand-50 font-medium text-brand-800' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>{d}</button>;
              })}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              Every <input type="number" min={1} max={90} className="input w-20 py-1.5" value={draft.every} onChange={(e) => set({ every: Number(e.target.value) })} /> days,
              starting <input type="date" className="input w-44 py-1.5" value={draft.startDate} onChange={(e) => set({ startDate: e.target.value })} />
              <span className="text-xs text-slate-500">(empty = the day you switch it on)</span>
            </div>
          )}
          <div className="mt-2"><Toggle checked={draft.skipHolidays} onChange={(v) => set({ skipHolidays: v })} label="Skip school holidays" hint="A reminder that falls on a holiday is skipped, not moved." /></div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button className="btn-secondary" disabled={busy || st.data.running} onClick={runNow}>Run now</button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="Which fees" hint="Due dates come from Frappe">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <select className="input w-auto py-1.5" value={draft.dueWithinDays === null ? 'all' : 'soon'} onChange={(e) => set({ dueWithinDays: e.target.value === 'all' ? null : draft.dueWithinDays ?? 7 })}>
                <option value="all">Everything outstanding</option>
                <option value="soon">Overdue + due within…</option>
              </select>
              {draft.dueWithinDays !== null && <><input type="number" min={0} max={365} className="input w-20 py-1.5" value={draft.dueWithinDays} onChange={(e) => set({ dueWithinDays: Number(e.target.value) })} /> days of the run</>}
            </div>
          </Field>
          <Field label="Only if the student owes at least (₹)"><input type="number" min={0} className="input w-40" value={draft.minAmount} onChange={(e) => set({ minAmount: Number(e.target.value) })} /></Field>
          <p className="text-xs text-slate-500">Sending stops at quiet hours and continues in the morning. Pacing follows the 💰 Fees message type.</p>
        </div>
        <Field label="Message" hint={<>Fields: <code>{'{{amount}}'}</code> <code>{'{{fee_list}}'}</code> <code>{'{{due_date}}'}</code> <code>{'{{student_name}}'}</code> <code>{'{{class}}'}</code> <code>{'{{father_name}}'}</code>. Also used by manual fees.</>}>
          <textarea className="input h-52 font-mono text-[13px]" value={draft.template} onChange={(e) => set({ template: e.target.value })} />
        </Field>
      </div>
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
            <thead><tr><th>When</th><th>Result</th><th>Outstanding</th><th>Skipped</th><th /></tr></thead>
            <tbody>{st.data.runs.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap text-xs">{fmtDate(r.started_at)}{r.manual && <div className="text-slate-500">run now</div>}</td>
                <td>{r.ok === null ? <Badge tone="amber">running</Badge> : !r.ok ? <span className="text-xs text-red-600">{r.summary?.error}</span>
                  : r.summary?.students ? <span className="text-sm">{r.summary.students} students · {r.summary.messages} msgs</span> : <span className="text-xs text-slate-500">nobody to remind</span>}</td>
                <td className="text-sm tabular-nums">{r.summary?.total ?? '—'}</td>
                <td className="text-xs text-amber-700">{[r.summary?.noFather ? `${r.summary.noFather} no father's number` : '', r.summary?.notInApp ? `${r.summary.notInApp} not in app` : ''].filter(Boolean).join(' · ') || '—'}</td>
                <td>{r.campaign_id && <Link to={`/campaigns/${r.campaign_id}`} className="text-xs text-brand-700 hover:underline">report →</Link>}</td>
              </tr>))}</tbody>
          </table>
        </details>
      )}
    </Card>
  );
}
