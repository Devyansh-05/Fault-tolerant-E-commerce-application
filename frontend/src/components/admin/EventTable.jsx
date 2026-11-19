import { StatusBadge } from '../Feedback.jsx';
import { formatDateTime } from '../../utils/format.js';

export const shortId = (id) => (id && id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

/** Table of event-processing records (one row = one event as handled by one consumer). */
export default function EventTable({ records, onSelect, maxAttempts, emptyMessage = 'No event-processing records match the filters.' }) {
  if (!records?.length) return <p className="muted empty-row">{emptyMessage}</p>;
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th>Event ID</th>
            <th>Event type</th>
            <th>Consumer</th>
            <th>Status</th>
            <th title="Attempt 1 is the initial execution; the rest are retries">Attempts</th>
            <th>Test</th>
            <th>Last error</th>
            <th>Created</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => onSelect?.(r.eventId)} title="Show processing history">
              <td><code>{shortId(r.eventId)}</code></td>
              <td className="small">{r.eventType}</td>
              <td>{r.consumerName}</td>
              <td>
                <StatusBadge status={r.status} />
                {r.duplicateCount > 0 && <span className="chip chip-neutral dup-chip" title="Duplicate deliveries detected">+{r.duplicateCount} dup</span>}
              </td>
              <td>
                {r.attempts}
                <span className="muted small"> / {r.maxAttempts ?? maxAttempts}</span>
              </td>
              <td>{r.isTestEvent ? <span className="chip chip-info">TEST</span> : <span className="muted small">real</span>}</td>
              <td className="error-cell small" title={r.lastError ?? ''}>{r.lastError ?? '—'}</td>
              <td className="small nowrap">{formatDateTime(r.firstReceivedAt ?? r.createdAt)}</td>
              <td className="small nowrap">{formatDateTime(r.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
