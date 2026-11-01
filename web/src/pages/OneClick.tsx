import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { Badge, Card, Empty, Field, PageHeader, statusLabel, statusTone, useLoad, useToast } from '../components/ui';
import { Phone, RevealAll, WaMark } from '../components/phone';
import { SCHOOL_LABEL } from '../components/rules';
import { ListPicker } from './CampaignEditor';
import type { GroupNode } from './Contacts';
import { DailyMarksReport, MarksPick, MarksPicker } from './MarksReport';
import { FeesReminders } from './FeesReport';

type Kind = 'marks' | 'fees';
interface Row {
  id: number; name: string; admission_no: string; class: string | null; section: string | null; summary: string;
  to: { relation: string; phone: string; optedOut: boolean; wa: boolean | null }[];
  status: 'ready' | 'no_number' | 'not_on_whatsapp' | 'opted_out';
  lastSent: { at: string; summary: string } | null; selected: boolean;
}
interface Fetched {
  fetchId: string; kind: Kind; label: string; fetchedAt: string; rows: Row[]; notInApp: number; total: string | null; alreadySent: number;
  type: { key: string; name: string; icon: string; school: keyof typeof SCHOOL_LABEL }; template: string;
}

const KINDS: Record<Kind, { icon: string; title: string; text: string; vars: [string, string][] }> = {
  marks: {
    icon: '📝', title: 'Assessment marks', text: 'Pick classes, dates and tests — both parents get one statement per child with the class rank when it is fair.',
    vars: [['marks', 'Test list'], ['total', 'Total'], ['max', 'Out of'], ['percent', '%'], ['rank_line', 'Rank / note'], ['period', 'Period'], ['student_name', 'Student'], ['class', 'Class'], ['section', 'Section'], ['parent_name', 'Parent']],
  },
  fees: {
    icon: '💰', title: 'Pending fees', text: "The father gets what's still outstanding for his child, straight from Frappe — weekly or every few days.",
    vars: [['amount', 'Amount due'], ['fee_list', 'Fee list'], ['due_date', 'Earliest due date'], ['fee_count', 'No. of fees'], ['student_name', 'Student'], ['class', 'Class'], ['section', 'Section'], ['parent_name', 'Parent']],
  },
};
const STATUS: Record<Row['status'], [string, string]> = {
  ready: ['Ready', 'green'], no_number: ['No number', 'red'], not_on_whatsapp: ['Not on WhatsApp', 'red'], opted_out: ['Replied STOP', 'amber'],
};

type Tab = 'auto' | 'manual';
interface HistoryRow {
  row: 'campaign' | 'run'; id: number; campaign_id: number | null; name: string; status: string; kind: Kind; auto: boolean;
  total: number; sent: number; read: number; failed: number; created_at: string;
}
const AUTO: Record<Kind, { title: string; status: string }> = {
  marks: { title: 'Daily Marks Report', status: '/oneclick/marks-report' },
  fees: { title: 'Fee reminders', status: '/oneclick/fees-report' },
};

export default function OneClick() {
  const [params, setParams] = useSearchParams();
  const kind = (params.get('kind') as Kind | null) ?? null;
  const tab: Tab = params.get('tab') === 'manual' ? 'manual' : 'auto';
  return (
    <>
      <PageHeader title={kind && KINDS[kind] ? `${KINDS[kind].icon} ${KINDS[kind].title}` : 'Special notifications'}
        subtitle="Personalised messages to parents, filled in from the school system — automatically on a schedule, or by hand"
        actions={kind && <button className="btn-secondary" onClick={() => setParams({})}>← Special notifications</button>} />
      {kind && KINDS[kind] ? (
        <div className="space-y-5">
          <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1 text-sm">
            {([['auto', '⏱ Automatic (scheduled)'], ['manual', '✋ Manual']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setParams({ kind, tab: k })} className={`rounded-lg px-4 py-1.5 ${tab === k ? 'bg-white font-semibold text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>{l}</button>))}
          </div>
          {tab === 'auto' ? (kind === 'marks' ? <DailyMarksReport /> : <FeesReminders />) : <Flow key={kind} kind={kind} />}
          <History kind={kind} />
        </div>
      ) : <Home onPick={(k) => setParams({ kind: k })} />}
    </>
  );
}

function Home({ onPick }: { onPick: (k: Kind) => void }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        {(Object.keys(KINDS) as Kind[]).map((k) => <KindCard key={k} kind={k} onPick={() => onPick(k)} />)}
      </div>
      <History />
    </div>
  );
}

function KindCard({ kind, onPick }: { kind: Kind; onPick: () => void }) {
  const { data } = useLoad(() => api.get<{ settings: { enabled: boolean }; running: boolean; nextRuns: string[] }>(AUTO[kind].status), [kind], 60_000);
  const on = data?.settings.enabled;
  return (
    <button onClick={onPick} className="card group p-5 text-left transition hover:border-brand-600 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="text-3xl">{KINDS[kind].icon}</div>
        {data && <Badge tone={on ? 'green' : 'slate'}>{data.running ? 'Running…' : on ? 'Automatic: on' : 'Automatic: off'}</Badge>}
      </div>
      <div className="mt-2 text-base font-semibold text-slate-900">{KINDS[kind].title}</div>
      <p className="mt-1 text-sm text-slate-600">{KINDS[kind].text}</p>
      <p className="mt-2 text-xs text-slate-500">
        {AUTO[kind].title}: {!data ? '…' : on ? (data.nextRuns[0] ? `next ${fmtDate(data.nextRuns[0])}` : 'no run coming up') : 'off'}
      </p>
      <span className="mt-3 inline-block text-sm font-medium text-brand-700 group-hover:underline">Open — automatic & manual →</span>
    </button>
  );
}

/** Every run, scheduled or manual, newest first. Scheduled runs that had nothing to send show up too. */
function History({ kind }: { kind?: Kind }) {
  const { data } = useLoad(() => api.get<HistoryRow[]>('/oneclick/history'), [], 30_000);
  const rows = (data ?? []).filter((h) => !kind || h.kind === kind);
  return (
    <Card title={kind ? 'History' : 'History — all runs'}>
      {rows.length ? (
        <table className="table">
          <thead><tr><th>When</th>{!kind && <th>Kind</th>}<th>Run</th><th>How</th><th>Status</th><th className="text-right">Sent</th><th className="text-right">Read</th></tr></thead>
          <tbody>{rows.map((h) => (
            <tr key={`${h.row}-${h.id}`}>
              <td className="whitespace-nowrap text-xs text-slate-500">{fmtDate(h.created_at)}</td>
              {!kind && <td className="whitespace-nowrap text-sm">{KINDS[h.kind]?.icon} {h.kind === 'marks' ? 'Marks' : 'Fees'}</td>}
              <td>{h.campaign_id ? <Link to={`/campaigns/${h.campaign_id}`} className="font-medium text-brand-700 hover:underline">{h.name}</Link> : <span className="text-slate-700">{h.name}</span>}</td>
              <td><Badge tone={h.auto ? 'violet' : 'blue'}>{h.auto ? 'Automatic' : 'Manual'}</Badge></td>
              <td><Badge tone={h.status === 'nothing to send' ? 'slate' : statusTone(h.status)}>{h.status}</Badge></td>
              <td className="text-right tabular-nums">{h.campaign_id ? `${h.sent}/${h.total}` : '—'}</td>
              <td className="text-right tabular-nums">{h.campaign_id ? h.read : '—'}</td>
            </tr>))}</tbody>
        </table>
      ) : <p className="text-sm text-slate-500">Nothing has run yet.</p>}
    </Card>
  );
}

function StepHead({ n, title, done, children }: { n: number; title: string; done?: boolean; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-semibold ${done ? 'bg-emerald-600 text-white' : 'bg-brand-600 text-white'}`}>{done ? '✓' : n}</span>
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      <span className="flex-1" />
      {children}
    </div>
  );
}

function Flow({ kind }: { kind: Kind }) {
  const toast = useToast();
  const nav = useNavigate();
  const K = KINDS[kind];
  const { data: tree } = useLoad(() => api.get<GroupNode[]>('/groups'), []);
  const { data: report } = useLoad(() => (kind === 'marks' ? api.get<any>('/oneclick/marks-report') : Promise.resolve(null)), [kind]);
  const { data: numbers } = useLoad(() => api.get<any[]>('/numbers'), []);
  const [pick, setPick] = useState<MarksPick | null>(null);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [dueBy, setDueBy] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [data, setData] = useState<Fetched | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'all' | 'selected' | 'problems' | 'sent'>('all');
  const [focus, setFocus] = useState<number | null>(null);
  const [template, setTemplate] = useState('');
  const [saveTpl, setSaveTpl] = useState(false);
  const [preview, setPreview] = useState<{ to: string; text: string } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [numberIds, setNumberIds] = useState<number[]>([]);
  const [sending, setSending] = useState(false);
  const text = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (numbers && !numberIds.length) setNumberIds(numbers.filter((n) => n.status === 'WORKING' && !n.paused && n.auto_use !== false).map((n) => n.id));
  }, [numbers]);

  const schoolTree = (tree ?? []).filter((g) => g.source === 'frappe');
  const fetchNow = async () => {
    setFetching(true); setFetchError(null);
    try {
      const r = await api.post<Fetched>('/oneclick/fetch', kind === 'marks'
        ? { kind, ...pick }
        : { kind, groupIds, dueBy: dueBy || null, minAmount: Number(minAmount) || 0 });
      setData(r);
      setSel(new Set(r.rows.filter((x) => x.selected).map((x) => x.id)));
      setFocus((r.rows.find((x) => x.selected) ?? r.rows.find((x) => x.status === 'ready') ?? r.rows[0])?.id ?? null);
      setTemplate((t) => t || r.template);
    } catch (e) { setFetchError((e as Error).message); setData(null); } finally { setFetching(false); }
  };

  // Live preview for the student in focus
  useEffect(() => {
    if (!data || focus === null || !template.trim()) { setPreview(null); return; }
    const t = setTimeout(() => {
      api.post('/oneclick/render', { fetchId: data.fetchId, studentId: focus, template })
        .then((r) => { setPreview(r); setPreviewErr(null); }).catch((e) => setPreviewErr((e as Error).message));
    }, 300);
    return () => clearTimeout(t);
  }, [data?.fetchId, focus, template]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) =>
      (!needle || `${r.name} ${r.admission_no} ${r.class} ${r.section}`.toLowerCase().includes(needle)) &&
      (show === 'all' || (show === 'selected' && sel.has(r.id)) || (show === 'problems' && r.status !== 'ready') || (show === 'sent' && r.lastSent)));
  }, [data, q, show, sel]);

  const counts = useMemo(() => {
    const all = data?.rows ?? [];
    return { all: all.length, ready: all.filter((r) => r.status === 'ready').length, problems: all.filter((r) => r.status !== 'ready').length, sent: all.filter((r) => r.lastSent).length };
  }, [data]);
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const insertVar = (v: string) => {
    const el = text.current; const tag = `{{${v}}}`;
    if (!el) return setTemplate((t) => t + tag);
    const [a, b] = [el.selectionStart, el.selectionEnd];
    setTemplate((t) => t.slice(0, a) + tag + t.slice(b));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + tag.length, a + tag.length); });
  };
  const parentsCount = useMemo(() => (data?.rows ?? []).filter((r) => sel.has(r.id)).reduce((a, r) => a + r.to.filter((t) => !t.optedOut && t.wa !== false).length, 0), [data, sel]);

  const send = async () => {
    if (!data) return;
    if (!confirm(`Send "${data.label}" to ${parentsCount} parent number${parentsCount === 1 ? '' : 's'} (${sel.size} student${sel.size === 1 ? '' : 's'})?`)) return;
    setSending(true);
    try {
      const r = await api.post('/oneclick/send', { fetchId: data.fetchId, studentIds: [...sel], template, numberIds, saveTemplate: saveTpl });
      toast(`Sending started — ${r.total} messages queued`);
      nav(`/campaigns/${r.campaignId}`);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setSending(false); }
  };

  const fixHint = (fetchError ?? '').includes("can't read");
  return (
    <div className="space-y-5">
      {/* 1. What */}
      <Card>
        <StepHead n={1} title={`${K.icon} ${K.title} — what to send`} done={!!data} />
        {kind === 'marks' ? (
          <MarksPicker tree={schoolTree} minPct={report?.settings?.rules?.minEnteredPct ?? 70} onChange={setPick} />
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Only fees due by" hint="Empty = everything outstanding"><input className="input" type="date" value={dueBy} onChange={(e) => setDueBy(e.target.value)} /></Field>
            <Field label="Only if at least (₹)"><input className="input" type="number" min={0} value={minAmount} onChange={(e) => setMinAmount(e.target.value)} placeholder="0" /></Field>
            <div>
              <span className="label">Classes (optional)</span>
              <ListPicker tree={schoolTree} ids={groupIds} onChange={setGroupIds} />
            </div>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-primary" disabled={fetching || (kind === 'marks' && !pick?.plans.length)} onClick={fetchNow}>
            {fetching ? 'Fetching from Frappe…' : data ? '↻ Fetch again' : kind === 'marks' ? 'Prepare messages' : 'Fetch from Frappe'}
          </button>
          {data && <span className="text-xs text-slate-500">Fetched {fmtDate(data.fetchedAt)} · {data.rows.length} students{data.total && <> · {data.total} outstanding</>}{data.notInApp > 0 && <> · {data.notInApp} not synced to the app yet</>}{data.alreadySent > 0 && <> · {data.alreadySent} results left out (already sent)</>}</span>}
        </div>
        {fetchError && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {fetchError}
            {fixHint && <p className="mt-1 text-xs text-red-600">This is a one-time permission in Frappe: Role Permission Manager → {kind === 'marks' ? 'Assessment Result' : 'Fees'} → give the API user's role <b>Read</b>.</p>}
          </div>
        )}
      </Card>

      {data && (
        <>
          {/* 2. Who */}
          <Card>
            <StepHead n={2} title="Check who gets it" done={sel.size > 0}>
              <RevealAll />
            </StepHead>
            {!data.rows.length ? <Empty>Nobody to notify{kind === 'fees' ? ' — no pending fees for these filters' : ' — everything in these tests was already sent (tick "Include marks already sent" for a full statement)'}.</Empty> : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <input className="input w-56 py-1.5" placeholder="Search student, adm. no, class…" value={q} onChange={(e) => setQ(e.target.value)} />
                  {([['all', `All ${counts.all}`], ['selected', `Selected ${sel.size}`], ['problems', `Can't reach ${counts.problems}`], ['sent', `Already sent ${counts.sent}`]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setShow(k)} className={`rounded-full px-3 py-1 text-xs ${show === k ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{l}</button>
                  ))}
                  <span className="flex-1" />
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setSel(new Set(data.rows.filter((r) => r.status === 'ready').map((r) => r.id)))}>Select all reachable</button>
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setSel(new Set())}>Clear</button>
                </div>
                <div className="max-h-[28rem] overflow-auto rounded-lg border border-slate-100">
                  <table className="table">
                    <thead className="sticky top-0 z-10 bg-white"><tr><th className="w-8" /><th>Student</th><th>Class</th><th>{kind === 'marks' ? 'Marks' : 'Due'}</th><th>Goes to</th><th>Status</th></tr></thead>
                    <tbody>{rows.map((r) => (
                      <tr key={r.id} onClick={() => setFocus(r.id)} className={`cursor-pointer ${focus === r.id ? 'bg-brand-50/60' : ''}`}>
                        <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(r.id)} disabled={r.status !== 'ready' && !sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} /></td>
                        <td><div className="font-medium">{r.name}</div><div className="text-xs text-slate-500">{r.admission_no}</div></td>
                        <td className="text-xs">{r.class}{r.section && <div className="text-slate-500">{r.section}</div>}</td>
                        <td className="whitespace-nowrap text-sm tabular-nums">{r.summary}</td>
                        <td className="text-xs">{r.to.length ? r.to.map((t) => (
                          <div key={t.phone} className="flex items-center gap-1.5 whitespace-nowrap"><span className="w-12 text-slate-500">{t.relation}</span><Phone value={t.phone} /><WaMark wa={t.wa} />{t.optedOut && <Badge tone="amber">STOP</Badge>}</div>
                        )) : <span className="text-red-600">no number</span>}</td>
                        <td>
                          <Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge>
                          {r.lastSent && <div className="mt-0.5 text-[11px] text-amber-700">Sent {fmtDate(r.lastSent.at)}{kind === 'fees' ? ` · ${r.lastSent.summary}` : ''}</div>}
                        </td>
                      </tr>))}</tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Goes to: <b>{SCHOOL_LABEL[data.type.school]}</b>{kind === 'marks'
                    ? ' (always, for marks — the same number twice gets one message).'
                    : " (always, for fees — students without a father's number can't be reached)."}
                  {counts.sent > 0 && ' Students already notified are not ticked — tick them to send again.'}
                </p>
              </>
            )}
          </Card>

          {/* 3. Message + send */}
          {data.rows.length > 0 && (
            <Card>
              <StepHead n={3} title="Message & send" />
              <div className="grid gap-5 lg:grid-cols-2">
                <div>
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {K.vars.map(([v, l]) => <button key={v} type="button" onClick={() => insertVar(v)} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 hover:bg-brand-50 hover:text-brand-800" title={`Insert {{${v}}}`}>{l}</button>)}
                  </div>
                  <textarea ref={text} className="input h-72 font-mono text-[13px] leading-relaxed" value={template} onChange={(e) => setTemplate(e.target.value)} />
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                    <span><code>*bold*</code> <code>_italic_</code> · click a field to insert it</span>
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={saveTpl} onChange={(e) => setSaveTpl(e.target.checked)} />Remember this message for next time</label>
                  </div>
                </div>
                <div>
                  <span className="label">Preview {preview && <span className="font-normal text-slate-500">— {preview.to}</span>}</span>
                  <div className="rounded-xl bg-[#e7ded4] p-3">
                    <div className="ml-auto max-w-[92%] whitespace-pre-wrap rounded-lg rounded-tr-none bg-[#d9fdd3] px-3 py-2 text-sm text-slate-800 shadow-sm">
                      {previewErr ? <span className="text-red-700">{previewErr}</span> : preview ? <WaText text={preview.text} /> : <span className="text-slate-500">Click a student to preview their message</span>}
                    </div>
                  </div>
                  <div className="mt-4">
                    <span className="label">Send from</span>
                    <div className="flex flex-wrap gap-2">
                      {numbers?.map((n) => {
                        const on = numberIds.includes(n.id);
                        return (
                          <button key={n.id} type="button" onClick={() => setNumberIds(on ? numberIds.filter((x) => x !== n.id) : [...numberIds, n.id])}
                            className={`rounded-lg border px-3 py-1.5 text-left text-sm ${on ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-100' : 'border-slate-200 hover:bg-slate-50'}`}>
                            <div className="font-medium">{on ? '☑' : '☐'} {n.label}</div>
                            <div className="text-xs text-slate-500">{n.paused ? 'paused' : statusLabel(n.status)} · {n.remaining_today} left today</div>
                          </button>);
                      })}
                    </div>
                  </div>
                  <button className="btn-primary mt-5 w-full py-2.5 text-base" disabled={sending || !sel.size || !numberIds.length || !template.trim() || !!previewErr} onClick={send}>
                    {sending ? 'Starting…' : sel.size ? `Send to ${parentsCount} parent${parentsCount === 1 ? '' : 's'} (${sel.size} student${sel.size === 1 ? '' : 's'})` : 'Select students to send'}
                  </button>
                  <p className="mt-2 text-center text-xs text-slate-500">Goes out with the safe pacing of the {data.type.name} type; quiet hours pause it at night. Progress opens next.</p>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/** WhatsApp-style formatting for the preview: *bold*, _italic_, ~strike~. */
function WaText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
  return <>{parts.map((p, i) =>
    /^\*.+\*$/.test(p) ? <b key={i}>{p.slice(1, -1)}</b> : /^_.+_$/.test(p) ? <i key={i}>{p.slice(1, -1)}</i> : /^~.+~$/.test(p) ? <s key={i}>{p.slice(1, -1)}</s> : <span key={i}>{p}</span>)}</>;
}
