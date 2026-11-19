import { StatusBadge } from '../Feedback.jsx';
import { formatDateTime } from '../../utils/format.js';

function params(f) {
  const parts = [];
  if (f.faultType === 'ARTIFICIAL_DELAY') parts.push(`${f.delayMs} ms delay`);
  if (f.faultType === 'DUPLICATE_DELIVERY') parts.push(`${f.copies} extra cop${f.copies === 1 ? 'y' : 'ies'}`);
  if (f.failureRate < 100) parts.push(`${f.failureRate}% chance`);
  parts.push(f.failureCount == null ? 'unlimited' : `limit ${f.failureCount} (remaining ${f.remaining})`);
  parts.push(f.applyTo === 'ALL' ? 'all events' : f.applyTo === 'TEST_EVENTS' ? 'test events' : 'real events');
  return parts.join(' · ');
}

/** Fault configuration as stored in the backend (Redis) — not frontend state. */
export default function ActiveFaults({ faults, onDisable, onDisableAll, busy }) {
  return (
    <section className="card panel">
      <div className="section-head">
        <h2>Configured faults</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDisableAll} disabled={busy || !faults.some((f) => f.enabled)}>
          Disable all faults
        </button>
      </div>
      {faults.length === 0 ? (
        <p className="muted">No faults configured. All consumers process events normally.</p>
      ) : (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr><th>Fault</th><th>Consumer</th><th>Status</th><th>Parameters</th><th title="Attempts that matched the fault / attempts actually affected">Matched / injected</th><th>Updated</th><th></th></tr>
            </thead>
            <tbody>
              {faults.map((f) => (
                <tr key={`${f.faultType}:${f.targetConsumer}`}>
                  <td>{f.label}</td>
                  <td>{f.targetConsumer}</td>
                  <td><StatusBadge status={f.active ? 'ACTIVE' : f.exhausted ? 'EXHAUSTED' : 'DISABLED'} /></td>
                  <td className="small">{params(f)}</td>
                  <td>{f.matchedAttempts} / <strong>{f.injectedCount}</strong></td>
                  <td className="small nowrap">{formatDateTime(f.lastInjectedAt ?? f.updatedAt)}</td>
                  <td>{f.enabled && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDisable(f)} disabled={busy}>Disable</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
