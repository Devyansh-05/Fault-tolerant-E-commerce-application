import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import ProductImage from '../components/ProductImage.jsx';
import { EmptyState, ErrorMessage, FINAL_ORDER_STATUSES, Spinner, StatusBadge } from '../components/Feedback.jsx';
import { orderService } from '../services/orderService.js';
import { formatDateTime, formatPrice } from '../utils/format.js';
import { getErrorMessage } from '../utils/errors.js';

const POLL_INTERVAL_MS = 2000;

function banner(order, replayed) {
  if (replayed) {
    return { tone: 'replayed', icon: '↺', title: 'Order already placed', text: 'We recognised a repeated submission and returned your original order. No duplicate order was created and you will not be charged twice.' };
  }
  switch (order.orderStatus) {
    case 'CONFIRMED':
      return { tone: '', icon: '✓', title: 'Thank you! Your order is confirmed.', text: 'Payment was received (simulated gateway) and your items are reserved. A confirmation e-mail has been queued.' };
    case 'PAYMENT_FAILED':
    case 'INVENTORY_FAILED':
      return { tone: 'failed', icon: '!', title: 'We could not complete your order', text: order.failureReason + (order.compensation?.paymentRefunded ? ' Your payment has been refunded.' : '') };
    default:
      return { tone: 'processing', icon: '…', title: 'Order received — processing', text: 'We are confirming your payment and reserving your items. This page updates automatically.' };
  }
}

const STEP_LABEL = { PENDING: 'Waiting…', SUCCEEDED: 'Succeeded', RESERVED: 'Reserved', FAILED: 'Failed' };

/** Order confirmation (right after checkout) and order details page. */
export default function OrderConfirmationPage() {
  const { id } = useParams();
  const location = useLocation();
  const justPlaced = location.state?.justPlaced;
  const replayed = location.state?.replayed;

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setLoading(true);
    orderService
      .get(id)
      .then(setOrder)
      .catch((err) => (err.response?.status === 404 || err.response?.status === 400 ? setNotFound(true) : setError(getErrorMessage(err))))
      .finally(() => setLoading(false));
  }, [id]);

  // The order is finalised asynchronously by the event consumers: poll until it is final.
  const isFinal = order ? FINAL_ORDER_STATUSES.includes(order.orderStatus) : true;
  useEffect(() => {
    if (isFinal) return undefined;
    const timer = setInterval(() => {
      orderService.get(id).then(setOrder).catch(() => {});
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [id, isFinal]);

  if (loading) return <Spinner label="Loading order…" />;
  if (notFound) {
    return (
      <div className="container page">
        <EmptyState title="Order not found" action={<Link to="/orders" className="btn btn-primary">My orders</Link>} />
      </div>
    );
  }
  if (error) return <div className="container page"><ErrorMessage message={error} /></div>;

  const a = order.shippingAddress;
  const info = banner(order, justPlaced && replayed);
  const showBanner = justPlaced || !isFinal || order.orderStatus !== 'CONFIRMED';
  return (
    <div className="container page narrow">
      {showBanner && (
        <div className={`confirmation-banner ${info.tone}`}>
          <div className="confirmation-icon">{info.icon}</div>
          <div>
            <h1>{info.title}</h1>
            <p>{info.text}</p>
          </div>
        </div>
      )}

      {order.fulfillment && (
        <div className="fulfillment card">
          <div className={`fulfillment-step ${order.fulfillment.payment.status.toLowerCase()}`}>
            <span className="muted small">Payment</span>
            <strong>{STEP_LABEL[order.fulfillment.payment.status]}</strong>
          </div>
          <div className={`fulfillment-step ${order.fulfillment.inventory.status.toLowerCase()}`}>
            <span className="muted small">Stock reservation</span>
            <strong>{STEP_LABEL[order.fulfillment.inventory.status]}</strong>
          </div>
          <div className={`fulfillment-step ${isFinal ? (order.orderStatus === 'CONFIRMED' ? 'succeeded' : 'failed') : 'pending'}`}>
            <span className="muted small">Order</span>
            <strong>{order.orderStatus.replace(/_/g, ' ')}</strong>
          </div>
          {!isFinal && <span className="spinner-inline small muted"><span className="spinner small-spinner" /> updating</span>}
        </div>
      )}

      <section className="card order-detail">
        <div className="order-detail-head">
          <div>
            <h2>{order.orderNumber}</h2>
            <span className="muted small">Placed {formatDateTime(order.createdAt)}</span>
          </div>
          <div className="badges">
            <StatusBadge status={order.orderStatus} />
            <StatusBadge status={order.paymentStatus} />
          </div>
        </div>

        {order.orderItems.map((item) => (
          <div key={item.productId} className="order-line">
            <div className="cart-thumb"><ProductImage src={item.image} alt={item.name} /></div>
            <div className="grow">
              <Link to={`/products/${item.productId}`} className="product-name">{item.name}</Link>
              <span className="muted small">{item.quantity} × {formatPrice(item.unitPrice)}</span>
            </div>
            <strong>{formatPrice(item.lineTotal)}</strong>
          </div>
        ))}

        <div className="summary-row total"><span>Total paid</span><span>{formatPrice(order.totalAmount)}</span></div>

        <div className="order-meta">
          <div>
            <h3>Shipping to</h3>
            <p>
              {a.fullName}<br />{a.addressLine1}{a.addressLine2 && <>, {a.addressLine2}</>}<br />
              {a.city}, {a.state} {a.postalCode}<br />{a.country}<br />{a.phone}
            </p>
          </div>
          <div>
            <h3>Payment</h3>
            <p>Simulated payment<br /><span className="muted small">Ref: <code>{order.paymentReference ?? '—'}</code></span></p>
            <h3>Status history</h3>
            <ul className="timeline">
              {order.statusHistory.map((s, i) => (
                <li key={i}><StatusBadge status={s.status} /> <span className="small muted">{formatDateTime(s.at)} — {s.note}</span></li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <div className="actions-row">
        <Link to="/orders" className="btn btn-outline">View all orders</Link>
        <Link to="/products" className="btn btn-primary">Continue shopping</Link>
      </div>
    </div>
  );
}
