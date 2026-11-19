import { useEffect, useState } from 'react';
import { ErrorMessage, Spinner, StatusBadge } from '../Feedback.jsx';
import { monitoringService } from '../../services/monitoringService.js';
import { formatDateTime } from '../../utils/format.js';
import { getErrorMessage } from '../../utils/errors.js';

const time = (d) => (d ? new Date(d).toLocaleTimeString([], { hour12: false }) + '.' + String(new Date(d).getMilliseconds()).padStart(3, '0') : '—');

/** Turns the stored history into readable lines: "Attempt 2 -> FAILED: reason". */
function describe(entry) {
  switch (entry.status) {
    case 'RECEIVED': return `Received${entry.message ? ` (${entry.message})` : ''}`;
    case 'PROCESSING': return `Attempt ${entry.attempt} started`;
    case 'COMPLETED': return `Attempt ${entry.attempt} -> COMPLETED`;
    case 'FAILED': return `Attempt ${entry.attempt} -> FAILED: ${entry.message}`;
    case 'RETRYING': return entry.message ? entry.message.replace(/^retry/, 'Retry') : 'Retry scheduled';
    case 'DLQ': return `Moved to Dead Letter Queue: ${entry.message}`;
    case 'DUPLICATE': return `Duplicate delivery detected and skipped (${entry.message})`;
    case 'DEFERRED': return `Delivery deferred: ${entry.message}`;
    case 'REPLAYED': return `Replay: ${entry.message}`;
    default: return entry.message || entry.status;
  }
}

/** Modal with the full processing history of one event across all consumers. */
export default function EventDetails({ eventId, onClose, onReplay }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    monitoringService
      .event(eventId)
      .then((d) => !cancelled && (setData(d), setError('')))
      .catch((err) => !cancelled && setError(getErrorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [eventId, reload]);

  // Keep the history live while any consumer is still working on the event.
  const busy = data?.consumers?.some((c) => !['COMPLETED', 'DLQ'].includes(c.status));
  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => setReload((r) => r + 1), 2000);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Event details</h2>
            <code className="small">{eventId}</code>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <ErrorMessage message={error} />
        {!data && !error && <Spinner label="Loading event…" />}
        {data && (
          <>
            <div className="detail-grid">
              <div><span className="muted small">Event type</span><strong>{data.eventType}</strong></div>
              <div><span className="muted small">Synthetic test event</span><strong>{data.isTestEvent ? `Yes (${data.testBatchId})` : 'No'}</strong></div>
              <div><span className="muted small">Created</span><strong>{formatDateTime(data.outbox?.eventCreatedAt)}</strong></div>
              <div>
                <span className="muted small">Outbox</span>
                <strong>
                  {data.outbox ? <StatusBadge status={data.outbox.status} /> : '—'}{' '}
                  {data.outbox && <span className="small muted">published {data.outbox.publishCount}×, {data.outbox.publishAttempts} attempt(s)</span>}
                </strong>
              </div>
            </div>

            {data.consumers.length === 0 && <p className="muted">No consumer has received this event yet.</p>}
            {data.consumers.map((c) => (
              <section key={c.consumerName} className="consumer-history">
                <div className="consumer-history-head">
                  <h3>{c.consumerName} consumer</h3>
                  <StatusBadge status={c.status} />
                  <span className="small muted">
                    attempts {c.attempts}/{c.maxAttempts} · retries {c.retryCount} · failed attempts {c.failedAttempts ?? 0} · deliveries {c.deliveries} · duplicates {c.duplicateCount}
                    {c.replayCount ? ` · replays ${c.replayCount}` : ''}
                  </span>
                  {c.status === 'DLQ' && onReplay && (
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => onReplay(c.eventId, c.consumerName, () => setReload((r) => r + 1))}>
                      Replay from DLQ
                    </button>
                  )}
                </div>
                {c.lastError && <p className="small text-danger">Last error: {c.lastError}</p>}
                <ol className="history">
                  {c.history.map((h, i) => (
                    <li key={i} className={`history-${h.status.toLowerCase()}`}>
                      <span className="history-time">{time(h.at)}</span>
                      <StatusBadge status={h.status} />
                      <span>{describe(h)}</span>
                    </li>
                  ))}
                </ol>
                {c.dlqHistory?.length > 0 && (
                  <div className="small muted">
                    Previous DLQ entries (audit):
                    {c.dlqHistory.map((d, i) => (
                      <div key={i}>• {formatDateTime(d.dlqAt)} after {d.attempts} attempts — replayed {formatDateTime(d.replayedAt)} by {d.replayedBy}</div>
                    ))}
                  </div>
                )}
              </section>
            ))}

            {data.childEvents.length > 0 && (
              <div className="small">
                <h3>Events caused by this event</h3>
                <ul className="plain-list">
                  {data.childEvents.map((e) => (
                    <li key={e.id}><StatusBadge status={e.status} /> {e.eventType} <code>{e.eventId.slice(0, 8)}…</code></li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
