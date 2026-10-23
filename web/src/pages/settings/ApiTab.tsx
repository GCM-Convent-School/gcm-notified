import { useState } from 'react';
import { api, fmtDate } from '../../api';
import { Badge, Card, Field, Modal, statusTone, useLoad, useToast } from '../../components/ui';
import { Phone } from '../../components/phone';

const ERRORS: [number, string, string][] = [
  [400, 'invalid_phone · message_required · message_too_long', 'Fix the request'],
  [401, 'missing_api_key · invalid_api_key', 'Check the key (or it was revoked)'],
  [404, 'number_not_found', 'The "number" you passed is not in GCM Notified'],
  [409, 'number_not_active · number_paused · opted_out', 'Pick another number / the person replied STOP'],
  [422, 'not_on_whatsapp', 'The phone is not on WhatsApp'],
  [429, 'rate_limited', 'Too many requests this minute'],
  [503, 'no_active_number', 'No current active number — connect one in Numbers'],
];

function Code({ children }: { children: string }) {
  const toast = useToast();
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 pr-16 text-xs leading-relaxed text-slate-100">{children}</pre>
      <button className="absolute right-2 top-2 rounded bg-white/10 px-2 py-1 text-[11px] text-white hover:bg-white/20"
        onClick={() => navigator.clipboard.writeText(children).then(() => toast('Copied'), () => toast('Copy failed', 'error'))}>Copy</button>
    </div>
  );
}

export function ApiTab({ perMinute, onPerMinute }: { perMinute: number; onPerMinute: (n: number) => void }) {
  const toast = useToast();
  const keys = useLoad(() => api.get<any[]>('/api-keys'), []);
  const numbers = useLoad(() => api.get<any[]>('/api-keys/numbers'), []);
  const recent = useLoad(() => api.get<any[]>('/api-keys/recent'), [], 15_000);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const base = `${location.origin}/api/v1`;
  const def = numbers.data?.find((n) => n.default);

  const create = async () => {
    try { const k = await api.post('/api-keys', { name }); setCreated(k); setName(''); keys.reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const revoke = async (k: any) => {
    if (!confirm(`Revoke "${k.name}"? Anything using this key stops working immediately.`)) return;
    try { await api.del(`/api-keys/${k.id}`); keys.reload(); toast('Key revoked'); } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div className="space-y-5">
      <Card title="API keys" actions={<span className="text-xs text-slate-500">Keys are shown once, then stored only as a fingerprint</span>}>
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <Field label="New key for"><input className="input w-64" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. School ERP, Website" onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()} /></Field>
          <button className="btn-primary" disabled={!name.trim()} onClick={create}>Create key</button>
        </div>
        {keys.data?.length ? (
          <table className="table">
            <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th className="text-right">Messages</th><th /></tr></thead>
            <tbody>{keys.data.map((k) => (
              <tr key={k.id} className={k.revoked_at ? 'opacity-50' : ''}>
                <td className="font-medium">{k.name}</td>
                <td className="font-mono text-xs">{k.prefix}…</td>
                <td className="text-xs text-slate-500">{fmtDate(k.created_at)}</td>
                <td className="text-xs text-slate-500">{k.last_used_at ? fmtDate(k.last_used_at) : 'never'}</td>
                <td className="text-right tabular-nums">{k.sent}</td>
                <td className="text-right">{k.revoked_at ? <Badge>revoked</Badge> : <button className="text-xs text-red-600 hover:underline" onClick={() => revoke(k)}>Revoke</button>}</td>
              </tr>))}</tbody>
          </table>
        ) : <p className="text-sm text-slate-500">No keys yet. Create one for each system that sends messages, so each can be revoked on its own.</p>}
      </Card>

      <Card title="Send a message / Webhook">
        <div className="space-y-4 text-sm">
          <p className="text-slate-600">
            Send a message via HTTP POST. You only need to pass the recipient's mobile number and message.
            The sender number is <b>automatically picked from any available connected WhatsApp number</b> using smart load balancing
            (prioritizing numbers with the highest remaining daily quota) unless you explicitly specify a sender number.
            {numbers.data ? def ? <> Recommended sender right now: <b>{def.label}</b> (<Phone value={def.phone} />).</> : <Badge tone="red">no current active number</Badge> : null}
          </p>
          <Code>{`curl -X POST ${base}/messages \\
  -H "Authorization: Bearer autosend_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "phone": "9876543210",
    "message": "Dear Parent,\\n*School will remain closed tomorrow* due to heavy rain.\\n_— GCM Convent School_"
  }'`}</Code>
          <p className="text-xs text-slate-500">
            Webhook endpoints <code>POST ${base}/webhook</code> and <code>POST ${base}/webhook/send</code> are also supported.
            You can authenticate with <code>Authorization: Bearer &lt;key&gt;</code>, <code>x-api-key: &lt;key&gt;</code>, or query parameter <code>?token=&lt;key&gt;</code>.
          </p>
          <table className="table">
            <thead><tr><th className="w-28">Field</th><th>Meaning</th></tr></thead>
            <tbody>
              <tr><td className="font-mono text-xs">phone / mobile</td><td>Required. Recipient mobile in any format (98765 43210, +91…, 0…). Other countries with country code.</td></tr>
              <tr><td className="font-mono text-xs">message / text</td><td>Required, up to 4096 characters. WhatsApp formatting: <code>*bold*</code> <code>_italic_</code> <code>~strike~</code> <code>```mono```</code>, new lines with <code>\n</code>.</td></tr>
              <tr><td className="font-mono text-xs">number / from</td><td>Optional. If omitted, smart load balancing chooses the best available active number under daily cap.</td></tr>
              <tr><td className="font-mono text-xs">ref</td><td>Optional. Idempotency reference for your message to prevent duplicate sends on retries.</td></tr>
            </tbody>
          </table>
          <p className="text-slate-600">Answer (<b>202</b>): the message is queued and goes out within seconds, with the number's safe pacing. Check it with <code>GET /api/v1/messages/&lt;id&gt;</code>:</p>
          <Code>{`{ "id": 1234, "status": "queued", "phone": "919876543210", "ref": null,
  "from": { "id": 2, "label": "School office", "phone": "91…" },
  "created_at": "…", "sent_at": null, "delivered_at": null }`}</Code>
          <p className="text-xs text-slate-500">Status moves queued → sent → delivered → read (or failed / skipped with an <code>error</code>). People who replied STOP are refused. API messages ignore quiet hours — your system decides when to send.</p>
          <table className="table">
            <thead><tr><th className="w-16">HTTP</th><th>error</th><th>What to do</th></tr></thead>
            <tbody>{ERRORS.map(([c, e, w]) => <tr key={c}><td className="tabular-nums">{c}</td><td className="font-mono text-xs">{e}</td><td className="text-xs">{w}</td></tr>)}</tbody>
          </table>
          <Field label="Requests per key per minute">
            <input className="input w-28" type="number" min={1} max={600} value={perMinute} onChange={(e) => onPerMinute(Number(e.target.value))} />
          </Field>
        </div>
      </Card>

      <Card title="Recent API messages">
        {recent.data?.length ? (
          <table className="table">
            <thead><tr><th>When</th><th>Key</th><th>To</th><th>From</th><th>Status</th></tr></thead>
            <tbody>{recent.data.map((m) => (
              <tr key={m.id}>
                <td className="text-xs text-slate-500">{fmtDate(m.created_at)}</td>
                <td className="text-xs">{m.key_name}{m.client_ref && <span className="ml-1 text-slate-400">#{m.client_ref}</span>}</td>
                <td><Phone value={m.phone} /></td>
                <td className="text-xs">{m.number_label}</td>
                <td><Badge tone={statusTone(m.status)}>{m.status}</Badge>{m.error && <div className="mt-0.5 text-xs text-slate-500">{m.error}</div>}</td>
              </tr>))}</tbody>
          </table>
        ) : <p className="text-sm text-slate-500">Nothing sent through the API yet.</p>}
      </Card>

      <Modal open={!!created} onClose={() => setCreated(null)} title={`Key for "${created?.name}"`}>
        <p className="mb-3 text-sm text-slate-600">Copy it now and store it in the other system's settings. <b>It won't be shown again</b> — if lost, revoke it and create a new one.</p>
        <Code>{created?.key ?? ''}</Code>
        <div className="mt-4 text-right"><button className="btn-primary" onClick={() => setCreated(null)}>Done</button></div>
      </Modal>
    </div>
  );
}
