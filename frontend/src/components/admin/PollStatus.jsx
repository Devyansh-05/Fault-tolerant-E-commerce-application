import { getErrorMessage } from '../../utils/errors.js';

/** "Last updated" indicator; shows a clear warning when the backend is unreachable. */
export default function PollStatus({ lastUpdated, error, onRefresh, intervalMs }) {
  return (
    <div className="poll-status">
      {error ? (
        <span className="poll-error" role="alert">
          ⚠ {getErrorMessage(error, 'Cannot reach the backend')}
          {lastUpdated && ` — figures below are from ${lastUpdated.toLocaleTimeString()} and may be outdated`}
        </span>
      ) : (
        <span className="muted small">
          <span className="live-dot" /> Auto-refresh every {Math.round(intervalMs / 1000)} s · last updated{' '}
          {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'}
        </span>
      )}
      {onRefresh && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh}>
          Refresh now
        </button>
      )}
    </div>
  );
}
