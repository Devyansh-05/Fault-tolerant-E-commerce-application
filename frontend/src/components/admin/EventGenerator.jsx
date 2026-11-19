import { useState } from 'react';
import { Link } from 'react-router-dom';
import { testingService } from '../../services/testingService.js';
import { useToast } from '../../context/ToastContext.jsx';
import { getErrorMessage } from '../../utils/errors.js';
import { formatDateTime } from '../../utils/format.js';

const PRESETS = [10, 50, 100];
const TYPES = [
  { value: 'TEST_ORDER_EVENT', label: 'Test Order Event (full flow: payment + inventory + order saga + email)' },
  { value: 'TEST_EMAIL_EVENT', label: 'Test Email Event (email consumer only)' },
];

/** Synthetic Event Generator — events go through the real outbox, RabbitMQ and consumers. */
export default function EventGenerator({ maxEvents }) {
  const toast = useToast();
  const [count, setCount] = useState('50');
  const [eventType, setEventType] = useState(TYPES[0].value);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const onGenerate = async () => {
    const n = Number(count);
    if (!/^\d+$/.test(String(count).trim()) || n < 1 || n > maxEvents) {
      setError(`Enter a whole number between 1 and ${maxEvents}`);
      return;
    }
    setError('');
    setBusy(true);
    try {
      const data = await testingService.generateEvents(n, eventType);
      setResult(data);
      toast.success(`${data.accepted} synthetic event(s) submitted (batch ${data.batchId})`);
    } catch (err) {
      const data = err.response?.data?.data;
      if (data) setResult(data);
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card panel">
      <h2>Synthetic Event Generator</h2>
      <p className="muted small">
        Creates clearly marked test events (synthetic customer and products — real stock and real customers are never touched) and sends them
        through the actual Outbox → RabbitMQ → consumers pipeline.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>Number of events (max {maxEvents})</span>
          <div className="preset-row">
            {PRESETS.filter((p) => p <= maxEvents).map((p) => (
              <button key={p} type="button" className={`btn btn-sm ${String(p) === String(count) ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setCount(String(p))} disabled={busy}>
                {p}
              </button>
            ))}
            <input className="preset-input" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} aria-label="Custom number of events" disabled={busy} />
          </div>
        </label>
        <label className="field">
          <span>Event type</span>
          <select value={eventType} onChange={(e) => setEventType(e.target.value)} disabled={busy}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <button type="button" className="btn btn-primary" onClick={onGenerate} disabled={busy}>
        {busy ? 'Submitting…' : 'Generate events'}
      </button>

      {result && (
        <div className="generation-result">
          <h3>Generation result</h3>
          <dl>
            <dt>Requested</dt><dd>{result.requested}</dd>
            <dt>Successfully submitted</dt><dd className="text-success">{result.accepted}</dd>
            <dt>Failed to submit</dt><dd className={result.failed ? 'text-danger' : ''}>{result.failed}</dd>
            <dt>Test batch ID</dt><dd><code>{result.batchId}</code></dd>
            <dt>Generated at</dt><dd>{formatDateTime(result.generatedAt)}</dd>
          </dl>
          <p className="small muted">
            “Submitted” means durably stored in the outbox — not yet processed. Watch the processing outcome on the{' '}
            <Link to={`/admin/reliability?batchId=${encodeURIComponent(result.batchId)}`}>Reliability Dashboard for this batch</Link>.
          </p>
        </div>
      )}
    </section>
  );
}
