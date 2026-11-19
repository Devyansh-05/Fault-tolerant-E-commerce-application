import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import MetricCard from '../../components/admin/MetricCard.jsx';
import PollStatus from '../../components/admin/PollStatus.jsx';
import ConsumerStats from '../../components/admin/ConsumerStats.jsx';
import EventTable from '../../components/admin/EventTable.jsx';
import EventDetails from '../../components/admin/EventDetails.jsx';
import Pagination from '../../components/Pagination.jsx';
import { ErrorMessage, Spinner, StatusBadge } from '../../components/Feedback.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { useDlqReplay } from '../../hooks/useDlqReplay.js';
import { monitoringService } from '../../services/monitoringService.js';
import { getErrorMessage } from '../../utils/errors.js';

const STATS_MS = 2500;
const TABLE_MS = 4000;
const STATUSES = ['', 'RECEIVED', 'PROCESSING', 'COMPLETED', 'RETRYING', 'FAILED', 'DLQ'];
const CONSUMERS = ['', 'payment', 'inventory', 'order', 'email'];
const EVENT_TYPES = ['', 'ORDER_CREATED', 'PAYMENT_COMPLETED', 'PAYMENT_FAILED', 'INVENTORY_RESERVED', 'INVENTORY_FAILED', 'ORDER_CONFIRMED', 'ORDER_FAILED', 'EMAIL_NOTIFICATION_REQUESTED'];

/** Reliability Dashboard — every number comes from the backend monitoring API. */
export default function ReliabilityDashboardPage() {
  const [params, setParams] = useSearchParams();
  const scope = params.get('scope') ?? 'all';
  const batchId = params.get('batchId') ?? '';
  const [filters, setFilters] = useState({ status: '', consumer: '', eventType: '', q: '' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);

  const setScope = (next) => {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v && v !== 'all' ? p.set(k, v) : p.delete(k)));
    setParams(p);
    setPage(1);
  };

  const stats = usePolling(() => monitoringService.stats({ scope, batchId }), STATS_MS, [scope, batchId]);
  const consumers = usePolling(() => monitoringService.consumerStats({ scope, batchId }), STATS_MS, [scope, batchId]);
  const table = usePolling(
    () => monitoringService.events({ ...filters, scope, batchId, page, limit: 15 }),
    TABLE_MS,
    [scope, batchId, page, filters.status, filters.consumer, filters.eventType, filters.q]
  );
  const refreshAll = useCallback(() => {
    stats.refresh();
    consumers.refresh();
    table.refresh();
  }, [stats, consumers, table]);
  const replay = useDlqReplay(refreshAll);

  const setFilter = (key) => (e) => {
    setFilters((f) => ({ ...f, [key]: e.target.value }));
    setPage(1);
  };

  const s = stats.data;
  const stale = Boolean(stats.error);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reliability Dashboard</h1>
          <p className="muted small">Live view of the Reliable Event Processor (outbox → RabbitMQ → consumers → retry / DLQ).</p>
        </div>
        <PollStatus lastUpdated={stats.lastUpdated} error={stats.error} onRefresh={refreshAll} intervalMs={STATS_MS} />
      </div>

      <div className="filter-bar card">
        <label className="field inline">
          <span>Events</span>
          <select value={scope} onChange={(e) => setScope({ scope: e.target.value, batchId })}>
            <option value="all">All events</option>
            <option value="test">Synthetic test events</option>
            <option value="real">Real application events</option>
          </select>
        </label>
        <label className="field inline">
          <span>Test batch</span>
          <input value={batchId} placeholder="all batches" onChange={(e) => setScope({ scope, batchId: e.target.value.trim() })} />
        </label>
        {s && (
          <span className="small">
            RabbitMQ: <StatusBadge status={s.broker.status === 'connected' ? 'COMPLETED' : 'FAILED'} /> {s.broker.status} · Outbox pending:{' '}
            <strong>{s.outbox.byStatus.PENDING + s.outbox.byStatus.PUBLISHING}</strong>
          </span>
        )}
      </div>

      {stats.loading && !s && <Spinner label="Loading statistics…" />}
      {!s && stats.error && <ErrorMessage message={getErrorMessage(stats.error)} onRetry={stats.refresh} />}
      {s && (
        <div className={stale ? 'stale' : ''}>
          <div className="metric-grid">
            <MetricCard label="Total events" value={s.logicalEvents} hint={`logical events · ${s.processingRecords} processing records`} />
            <MetricCard label="Successfully processed" value={s.successful} tone="success" hint="processing records COMPLETED" />
            <MetricCard label="Currently processing" value={s.currentlyProcessing} tone="info" hint="records being handled now" />
            <MetricCard label="Retrying" value={s.retrying} tone="warning" hint={`waiting for a retry · ${s.retried} record(s) needed retries`} />
            <MetricCard label="Duplicate deliveries" value={s.duplicateDeliveries} tone="neutral" hint={`detected & skipped in ${s.recordsWithDuplicates} record(s)`} />
            <MetricCard label="Failed attempts" value={s.failedAttempts} tone="danger" hint={`attempts that threw an error · ${s.failed} awaiting retry scheduling`} />
            <MetricCard label="Events in DLQ" value={s.inDlq} tone="dark" hint="retries exhausted or permanent failure" />
          </div>
          <p className="small muted definitions">
            <strong>Definitions:</strong> a <em>logical event</em> is one eventId in the outbox ({s.outbox.byStatus.PUBLISHED} published,{' '}
            {s.outbox.byStatus.PENDING} pending; {s.outbox.publishedMoreThanOnce} published more than once). One event is handled by one or two consumers,
            each producing one <em>processing record</em>. Retries never create records — they increase attempts ({s.attempts} attempts in total, {s.totalRetries} retries).
            Retry policy: attempt 1 + {s.retryPolicy.maxRetries} retries = {s.retryPolicy.maxAttempts} attempts max. {s.testEventsGenerated} synthetic event(s) in scope ·
            {` ${s.replays}`} DLQ replay(s) · avg processing {s.avgProcessingMs ?? '—'} ms.
          </p>
        </div>
      )}

      <section className="card">
        <h2>Consumer statistics</h2>
        {consumers.data ? <ConsumerStats consumers={consumers.data.consumers} /> : consumers.error ? <ErrorMessage message={getErrorMessage(consumers.error)} /> : <Spinner inline />}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>Event processing records</h2>
          <span className="muted small">click a row for its processing history · refresh every {TABLE_MS / 1000} s</span>
        </div>
        <div className="filter-row">
          <select value={filters.status} onChange={setFilter('status')} aria-label="Status">
            {STATUSES.map((v) => <option key={v} value={v}>{v || 'Any status'}</option>)}
          </select>
          <select value={filters.consumer} onChange={setFilter('consumer')} aria-label="Consumer">
            {CONSUMERS.map((v) => <option key={v} value={v}>{v || 'Any consumer'}</option>)}
          </select>
          <select value={filters.eventType} onChange={setFilter('eventType')} aria-label="Event type">
            {EVENT_TYPES.map((v) => <option key={v} value={v}>{v || 'Any event type'}</option>)}
          </select>
          <input value={filters.q} onChange={setFilter('q')} placeholder="Event ID starts with…" aria-label="Search event ID" />
        </div>
        {table.error && <ErrorMessage message={`Could not refresh the table: ${getErrorMessage(table.error)}`} />}
        {table.data ? (
          <>
            <EventTable records={table.data.records} onSelect={setSelected} maxAttempts={s?.retryPolicy.maxAttempts} />
            <div className="table-foot">
              <span className="muted small">{table.data.pagination.total} record(s)</span>
              <Pagination page={page} totalPages={table.data.pagination.totalPages} onChange={setPage} />
            </div>
          </>
        ) : (
          !table.error && <Spinner inline />
        )}
      </section>

      {selected && <EventDetails eventId={selected} onClose={() => setSelected(null)} onReplay={replay} />}
    </>
  );
}
