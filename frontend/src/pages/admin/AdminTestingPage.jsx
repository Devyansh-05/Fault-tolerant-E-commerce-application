import { useState } from 'react';
import { Link } from 'react-router-dom';
import FaultConfiguration from '../../components/admin/FaultConfiguration.jsx';
import ActiveFaults from '../../components/admin/ActiveFaults.jsx';
import EventGenerator from '../../components/admin/EventGenerator.jsx';
import DuplicateDelivery from '../../components/admin/DuplicateDelivery.jsx';
import PollStatus from '../../components/admin/PollStatus.jsx';
import { ErrorMessage, Spinner, StatusBadge } from '../../components/Feedback.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { testingService } from '../../services/testingService.js';
import { monitoringService } from '../../services/monitoringService.js';
import { useToast } from '../../context/ToastContext.jsx';
import { getErrorMessage } from '../../utils/errors.js';

const POLL_MS = 3000;

/** Admin Testing Panel: fault injection, synthetic events, duplicate delivery, outage guide. */
export default function AdminTestingPage() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const faults = usePolling(() => testingService.faults(), POLL_MS);
  const stats = usePolling(() => monitoringService.stats(), POLL_MS);

  const disableOne = async (f) => {
    setBusy(true);
    try {
      await testingService.disableFault(f.faultType, f.targetConsumer);
      toast.success(`${f.label} disabled on ${f.targetConsumer}`);
      faults.refresh();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const disableAll = async () => {
    setBusy(true);
    try {
      const res = await testingService.disableAll();
      toast.success(res.message);
      faults.refresh();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const resetData = async () => {
    if (!window.confirm('Delete ALL synthetic test data (test orders, test events and their processing records)?\nReal customer data is not affected.')) return;
    setBusy(true);
    try {
      const res = await testingService.resetTestData();
      const d = res.data.deleted;
      toast.success(`Deleted ${d.outboxEvents} test events, ${d.processingRecords} processing records and ${d.orders} test orders`);
      stats.refresh();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (faults.loading && !faults.data) return <Spinner label="Loading testing tools…" />;
  if (faults.error?.response?.data?.error?.code === 'TESTING_TOOLS_DISABLED') {
    return <ErrorMessage message="Fault injection and test-event generation are disabled in this environment (production or FAULT_INJECTION_ENABLED=false)." />;
  }
  if (!faults.data) return <ErrorMessage message={getErrorMessage(faults.error)} onRetry={faults.refresh} />;

  const overview = faults.data;
  const broker = stats.data?.broker?.status;
  const outbox = stats.data?.outbox?.byStatus;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Admin Testing Panel</h1>
          <p className="muted small">Inject controlled faults and generate synthetic events, then watch the <Link to="/admin/reliability">Reliability Dashboard</Link>.</p>
        </div>
        <PollStatus lastUpdated={faults.lastUpdated} error={faults.error} intervalMs={POLL_MS} />
      </div>

      <div className="testing-grid">
        <FaultConfiguration overview={overview} onChanged={faults.refresh} />
        <EventGenerator maxEvents={overview.limits.maxGeneratedEvents} />
      </div>

      <ActiveFaults faults={overview.faults} onDisable={disableOne} onDisableAll={disableAll} busy={busy} />
      <DuplicateDelivery />

      <section className="card panel">
        <h2>RabbitMQ unavailability (real outage)</h2>
        <p className="small">
          This fault is demonstrated with the real broker, not a flag. Current broker connection of the API:{' '}
          {broker ? <StatusBadge status={broker === 'connected' ? 'COMPLETED' : 'FAILED'} /> : '—'} <strong>{broker ?? 'unknown'}</strong>
          {outbox && <> · outbox: {outbox.PENDING} pending, {outbox.PUBLISHING} publishing, {outbox.PUBLISHED} published</>}
        </p>
        <ol className="small steps">
          <li>In a terminal: <code>docker stop ecommerce-rabbitmq</code></li>
          <li>Generate events above (or place an order in the shop) — they are accepted and stored in the MongoDB outbox as <strong>PENDING</strong>.</li>
          <li>The pending count above grows; the dashboard shows the broker as disconnected. Nothing is lost or marked successful.</li>
          <li>Restart: <code>docker start ecommerce-rabbitmq</code> (RabbitMQ needs ~15 s to boot).</li>
          <li>The worker reconnects, publishes the pending events, and the consumers process them.</li>
        </ol>
      </section>

      <section className="card panel">
        <div className="section-head">
          <div>
            <h2>Reset synthetic test data</h2>
            <p className="muted small">
              Deletes test orders, test events and their processing records so a demonstration can start from zero. Real customer data is never
              deleted. Not allowed while test events are still being processed.
            </p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={resetData} disabled={busy}>Reset test data</button>
        </div>
      </section>
    </>
  );
}
