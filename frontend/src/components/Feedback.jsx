/** Small shared feedback components: loading spinner, empty state, error box, status badge. */

export function Spinner({ label = 'Loading…', inline = false }) {
  return (
    <div className={inline ? 'spinner-inline' : 'spinner-wrap'} role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label}</span>
    </div>
  );
}

export function EmptyState({ title, message, action }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {message && <p className="muted">{message}</p>}
      {action}
    </div>
  );
}

export function ErrorMessage({ message, onRetry }) {
  if (!message) return null;
  return (
    <div className="alert alert-error" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

// COMPLETED green · PROCESSING blue · RETRYING orange · FAILED red · DLQ dark red · DUPLICATE grey
const STATUS_TONE = {
  CONFIRMED: 'success', PAID: 'success', SUCCEEDED: 'success', RESERVED: 'success', COMPLETED: 'success', PUBLISHED: 'success', ACTIVE: 'danger',
  PROCESSING: 'info', RECEIVED: 'info', PUBLISHING: 'info',
  PENDING: 'warning', RETRYING: 'warning', DEFERRED: 'warning', REPLAYED: 'warning', EXHAUSTED: 'neutral',
  FAILED: 'danger', CANCELLED: 'danger', PAYMENT_FAILED: 'danger', INVENTORY_FAILED: 'danger',
  DLQ: 'dark',
  REFUNDED: 'neutral', DUPLICATE: 'neutral', DISABLED: 'neutral',
};

export function StatusBadge({ status }) {
  return <span className={`chip chip-${STATUS_TONE[status] ?? 'neutral'}`}>{String(status).replace(/_/g, ' ')}</span>;
}

/** Order statuses after which nothing changes any more. */
export const FINAL_ORDER_STATUSES = ['CONFIRMED', 'PAYMENT_FAILED', 'INVENTORY_FAILED', 'CANCELLED', 'FAILED'];
