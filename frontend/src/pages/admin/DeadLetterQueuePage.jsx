import { useState } from 'react';
import PollStatus from '../../components/admin/PollStatus.jsx';
import EventDetails from '../../components/admin/EventDetails.jsx';
import { shortId } from '../../components/admin/EventTable.jsx';
import Pagination from '../../components/Pagination.jsx';
import { EmptyState, ErrorMessage, Spinner } from '../../components/Feedback.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { useDlqReplay } from '../../hooks/useDlqReplay.js';
import { monitoringService } from '../../services/monitoringService.js';
import { formatDateTime } from '../../utils/format.js';
import { getErrorMessage } from '../../utils/errors.js';

const POLL_MS = 4000;

/** Dead Letter Queue: events whose retries were exhausted (or that failed permanently). */
export default function DeadLetterQueuePage() {
  const [consumer, setConsumer] = useState('');
  const [scope, setScope] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const dlq = usePolling(() => monitoringService.dlq({ consumer, scope, page, limit: 15 }), POLL_MS, [consumer, scope, page]);
  const replay = useDlqReplay(dlq.refresh);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dead Letter Queue</h1>
          <p className="muted small">
            Records are kept for inspection (never deleted automatically). Replay sends the original event back through the normal pipeline —
            it is only marked COMPLETED if processing really succeeds.
          </p>
        </div>
        <PollStatus lastUpdated={dlq.lastUpdated} error={dlq.error} onRefresh={dlq.refresh} intervalMs={POLL_MS} />
      </div>

      {dlq.data && (
        <div className="metric-grid small-metrics">
          {dlq.data.queues.map((q) => (
            <div key={q.consumer} className="metric card metric-dark">
              <span className="metric-label">{q.consumer} DLQ (RabbitMQ)</span>
              <span className="metric-value">{q.messages ?? '—'}</span>
              <span className="metric-hint"><code>{q.queue}</code></span>
            </div>
          ))}
        </div>
      )}

      <section className="card">
        <div className="filter-row">
          <select value={consumer} onChange={(e) => (setConsumer(e.target.value), setPage(1))} aria-label="Consumer">
            <option value="">All consumers</option>
            <option value="payment">payment</option>
            <option value="inventory">inventory</option>
            <option value="order">order</option>
            <option value="email">email</option>
          </select>
          <select value={scope} onChange={(e) => (setScope(e.target.value), setPage(1))} aria-label="Scope">
            <option value="all">All events</option>
            <option value="test">Synthetic test events</option>
            <option value="real">Real application events</option>
          </select>
        </div>

        {dlq.loading && !dlq.data && <Spinner />}
        {dlq.error && <ErrorMessage message={getErrorMessage(dlq.error)} onRetry={dlq.refresh} />}
        {dlq.data && dlq.data.records.length === 0 && <EmptyState title="The Dead Letter Queue is empty" message="No event has exhausted its retries." />}
        {dlq.data && dlq.data.records.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr><th>Event ID</th><th>Consumer</th><th>Event type</th><th>Attempts</th><th>Failure</th><th>Last error</th><th>Failed at</th><th>Test</th><th></th></tr>
                </thead>
                <tbody>
                  {dlq.data.records.map((r) => (
                    <tr key={r.id}>
                      <td><button type="button" className="link-btn" onClick={() => setSelected(r.eventId)}><code>{shortId(r.eventId)}</code></button></td>
                      <td>{r.consumerName}</td>
                      <td className="small">{r.eventType}</td>
                      <td>{r.attempts}{r.replayCount ? <span className="muted small"> ({r.replayCount} replay)</span> : null}</td>
                      <td className="small">{r.failureType}</td>
                      <td className="error-cell small" title={r.lastError}>{r.lastError}</td>
                      <td className="small nowrap">{formatDateTime(r.dlqAt)}</td>
                      <td>{r.isTestEvent ? <span className="chip chip-info">TEST</span> : <span className="muted small">real</span>}</td>
                      <td>
                        {r.failureType === 'PERMANENT' && r.eventType === 'INVALID' ? (
                          <span className="muted small">not replayable</span>
                        ) : (
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => replay(r.eventId, r.consumerName)}>Replay</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span className="muted small">{dlq.data.pagination.total} record(s) in the DLQ</span>
              <Pagination page={page} totalPages={dlq.data.pagination.totalPages} onChange={setPage} />
            </div>
          </>
        )}
      </section>

      {selected && <EventDetails eventId={selected} onClose={() => setSelected(null)} onReplay={replay} />}
    </>
  );
}
