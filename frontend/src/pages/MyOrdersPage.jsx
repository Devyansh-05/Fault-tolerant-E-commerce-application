import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Pagination from '../components/Pagination.jsx';
import { EmptyState, ErrorMessage, Spinner, StatusBadge } from '../components/Feedback.jsx';
import { orderService } from '../services/orderService.js';
import { formatDateTime, formatPrice } from '../utils/format.js';
import { getErrorMessage } from '../utils/errors.js';

export default function MyOrdersPage() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ orders: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError('');
    orderService
      .list({ page, limit: 10 })
      .then(setData)
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [page, reload]);

  return (
    <div className="container page narrow">
      <div className="page-head">
        <h1>My orders</h1>
        {data.pagination && <span className="muted">{data.pagination.total} orders</span>}
      </div>
      <ErrorMessage message={error} onRetry={() => setReload((r) => r + 1)} />
      {loading ? (
        <Spinner label="Loading orders…" />
      ) : data.orders.length === 0 && !error ? (
        <EmptyState title="No orders yet" message="When you place an order it will appear here." action={<Link to="/products" className="btn btn-primary">Start shopping</Link>} />
      ) : (
        <>
          <div className="order-list">
            {data.orders.map((order) => (
              <Link key={order.id} to={`/orders/${order.id}`} className="card order-card">
                <div>
                  <strong>{order.orderNumber}</strong>
                  <span className="muted small">{formatDateTime(order.createdAt)} · {order.orderItems.reduce((n, i) => n + i.quantity, 0)} item(s)</span>
                  <span className="small order-card-items">{order.orderItems.map((i) => i.name).join(', ')}</span>
                </div>
                <div className="order-card-right">
                  <span className="price">{formatPrice(order.totalAmount)}</span>
                  <div className="badges">
                    <StatusBadge status={order.orderStatus} />
                    <StatusBadge status={order.paymentStatus} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
          <Pagination page={page} totalPages={data.pagination?.totalPages} onChange={setPage} />
        </>
      )}
    </div>
  );
}
