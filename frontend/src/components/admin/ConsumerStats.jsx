const CONSUMER_LABEL = {
  payment: 'Payment Consumer',
  inventory: 'Inventory Consumer',
  order: 'Order Saga Consumer',
  email: 'Email Consumer',
};

/** Per-consumer statistics (from GET /api/events/consumer-stats). */
export default function ConsumerStats({ consumers }) {
  if (!consumers) return null;
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th>Consumer</th>
            <th title="Processing records = events handled by this consumer">Records</th>
            <th>Completed</th>
            <th>Processing</th>
            <th>Retrying</th>
            <th>DLQ</th>
            <th title="Handler executions (attempt 1 + retries)">Attempts</th>
            <th>Failed attempts</th>
            <th>Duplicates</th>
            <th title="Messages waiting in the RabbitMQ queue / live consumers">Queue</th>
            <th>DLQ depth</th>
          </tr>
        </thead>
        <tbody>
          {consumers.map((c) => (
            <tr key={c.consumer}>
              <td>
                <strong>{CONSUMER_LABEL[c.consumer] ?? c.consumer}</strong>
                <div className="muted small">{c.routingKeys.join(', ')}</div>
              </td>
              <td>{c.total}</td>
              <td className="text-success">{c.byStatus.COMPLETED}</td>
              <td>{c.byStatus.PROCESSING + c.byStatus.RECEIVED}</td>
              <td className={c.byStatus.RETRYING ? 'text-warning' : ''}>{c.byStatus.RETRYING}</td>
              <td className={c.byStatus.DLQ ? 'text-danger' : ''}>{c.byStatus.DLQ}</td>
              <td>{c.attempts}</td>
              <td className={c.failedAttempts ? 'text-danger' : ''}>{c.failedAttempts}</td>
              <td>{c.duplicates}</td>
              <td>
                {c.queue.depth ?? '—'}
                <span className="muted small"> / {c.queue.consumers ?? '—'} live</span>
              </td>
              <td>{c.dlq.depth ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
