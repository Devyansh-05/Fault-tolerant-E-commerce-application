import { useState } from 'react';
import { testingService } from '../../services/testingService.js';
import { monitoringService } from '../../services/monitoringService.js';
import { useToast } from '../../context/ToastContext.jsx';
import { getErrorMessage } from '../../utils/errors.js';

/** Delivers an EXISTING event again (same eventId, same content) — duplicate-delivery demo. */
export default function DuplicateDelivery() {
  const toast = useToast();
  const [eventId, setEventId] = useState('');
  const [copies, setCopies] = useState('2');
  const [consumer, setConsumer] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const useLatest = async () => {
    try {
      const { records } = await monitoringService.events({ eventType: 'ORDER_CREATED', status: 'COMPLETED', consumer: 'payment', scope: 'test', limit: 1 });
      if (!records.length) return toast.info('No completed test ORDER_CREATED event yet — generate some events first.');
      setEventId(records[0].eventId);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const onSend = async () => {
    setBusy(true);
    try {
      const res = await testingService.duplicateDelivery(eventId.trim(), Number(copies), consumer || undefined);
      setResult(res.data);
      toast.success(`${res.message} → ${res.data.deliveredTo.join(', ')}`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card panel">
      <h2>Duplicate delivery of an existing event</h2>
      <p className="muted small">
        Publishes the stored event again with the <strong>same event ID</strong>. Event idempotency must recognise every copy: the record’s
        duplicate counter increases, attempts do not, and no second payment, stock deduction or e-mail is created.
      </p>
      <div className="form-grid">
        <label className="field span-2">
          <span>Event ID</span>
          <div className="preset-row">
            <input value={eventId} onChange={(e) => setEventId(e.target.value)} placeholder="e.g. 3f1c5a8e-…" disabled={busy} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={useLatest} disabled={busy}>Use latest test order event</button>
          </div>
        </label>
        <label className="field">
          <span>Copies (1–10)</span>
          <input inputMode="numeric" value={copies} onChange={(e) => setCopies(e.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span>Deliver to</span>
          <select value={consumer} onChange={(e) => setConsumer(e.target.value)} disabled={busy}>
            <option value="">Every consumer that receives this event</option>
            <option value="payment">Payment only</option>
            <option value="inventory">Inventory only</option>
            <option value="order">Order saga only</option>
            <option value="email">Email only</option>
          </select>
        </label>
      </div>
      <button type="button" className="btn btn-primary" onClick={onSend} disabled={busy || eventId.trim().length < 8}>
        {busy ? 'Sending…' : 'Deliver again'}
      </button>
      {result && (
        <p className="small">
          Sent {result.copies} cop{result.copies === 1 ? 'y' : 'ies'} of <code>{result.eventId}</code> ({result.eventType}) to {result.deliveredTo.join(', ')}.
          Open the event on the Reliability Dashboard to see the DUPLICATE entries.
        </p>
      )}
    </section>
  );
}
