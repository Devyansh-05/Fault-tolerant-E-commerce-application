import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorMessage, Spinner, StatusBadge } from '../../components/Feedback.jsx';
import { adminService } from '../../services/adminService.js';
import { formatDateTime, formatPrice } from '../../utils/format.js';
import { getErrorMessage } from '../../utils/errors.js';

/** Stage 1 admin overview — all numbers come from the backend (MongoDB counts). */
export default function AdminDashboardPage() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError('');
    adminService
      .overview()
      .then(setStats)
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading && !stats) return <Spinner label="Loading dashboard…" />;

  return (
    <>
      <div className="page-head">
        <h1>Overview</h1>
        <button type="button" className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <ErrorMessage message={error} onRetry={load} />
      {stats && (
        <>
          <div className="stat-grid">
            <div className="stat card"><span className="stat-label">Registered users</span><span className="stat-value">{stats.totalUsers}</span></div>
            <div className="stat card"><span className="stat-label">Active products</span><span className="stat-value">{stats.totalProducts}</span></div>
            <div className="stat card"><span className="stat-label">Total orders</span><span className="stat-value">{stats.totalOrders}</span></div>
            <div className="stat card"><span className="stat-label">Confirmed revenue</span><span className="stat-value">{formatPrice(stats.confirmedRevenue)}</span></div>
          </div>

          <section className="card">
            <h2>Recent orders</h2>
            {stats.recentOrders.length === 0 ? (
              <p className="muted">No orders yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Order</th><th>Customer</th><th>Placed</th><th>Total</th><th>Status</th><th>Payment</th></tr>
                  </thead>
                  <tbody>
                    {stats.recentOrders.map((o) => (
                      <tr key={o.id}>
                        <td><Link to={`/orders/${o.id}`}>{o.orderNumber}</Link></td>
                        <td>{o.customer ? <>{o.customer.name}<br /><span className="muted small">{o.customer.email}</span></> : '—'}</td>
                        <td className="small">{formatDateTime(o.createdAt)}</td>
                        <td>{formatPrice(o.totalAmount)}</td>
                        <td><StatusBadge status={o.orderStatus} /></td>
                        <td><StatusBadge status={o.paymentStatus} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
