import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ErrorMessage, Spinner } from '../components/Feedback.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useCart } from '../context/CartContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { orderService } from '../services/orderService.js';
import { formatPrice } from '../utils/format.js';
import { getErrorCode, getErrorMessage, isNetworkOrTimeout } from '../utils/errors.js';
import { clearCheckoutKey, getCheckoutKey } from '../utils/idempotency.js';

const ADDRESS_FIELDS = [
  ['fullName', 'Full name', 'name'],
  ['phone', 'Phone', 'tel'],
  ['addressLine1', 'Address line 1', 'address-line1'],
  ['addressLine2', 'Address line 2 (optional)', 'address-line2'],
  ['city', 'City', 'address-level2'],
  ['state', 'State', 'address-level1'],
  ['postalCode', 'Postal code', 'postal-code'],
  ['country', 'Country', 'country-name'],
];

function validateAddress(a) {
  const errors = {};
  if (a.fullName.trim().length < 2) errors.fullName = 'Enter your full name';
  if (!/^\+?[0-9\s-]{7,20}$/.test(a.phone.trim())) errors.phone = 'Enter a valid phone number';
  if (a.addressLine1.trim().length < 3) errors.addressLine1 = 'Enter your street address';
  if (a.city.trim().length < 2) errors.city = 'Enter your city';
  if (a.state.trim().length < 2) errors.state = 'Enter your state';
  if (!/^[A-Za-z0-9\s-]{3,12}$/.test(a.postalCode.trim())) errors.postalCode = 'Enter a valid postal code';
  if (a.country.trim().length < 2) errors.country = 'Enter your country';
  return errors;
}

export default function CheckoutPage() {
  const { user } = useAuth();
  const { cart, loading, refresh } = useCart();
  const toast = useToast();
  const navigate = useNavigate();

  const [address, setAddress] = useState({
    fullName: user?.name ?? '', phone: '', addressLine1: '', addressLine2: '',
    city: '', state: '', postalCode: '', country: 'India',
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // When the outcome of a request is unknown (timeout / network error) the user can
  // retry; the retry reuses the SAME Idempotency-Key so no duplicate order can result.
  const [canRetry, setCanRetry] = useState(false);
  const [activeKey, setActiveKey] = useState('');

  const items = useMemo(() => cart.items.filter((i) => i.isAvailable), [cart.items]);

  if (loading && cart.items.length === 0) return <Spinner label="Loading checkout…" />;
  if (!submitting && items.length === 0) return <Navigate to="/cart" replace />;

  const placeOrder = async () => {
    const errors = validateAddress(address);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const payload = {
      items: items.map(({ productId, quantity }) => ({ productId, quantity })),
      shippingAddress: Object.fromEntries(Object.entries(address).map(([k, v]) => [k, v.trim()])),
    };
    // Same payload as a pending submission -> same key; otherwise a fresh UUID.
    const key = getCheckoutKey(payload);
    setActiveKey(key);
    setSubmitting(true);
    setError('');
    setCanRetry(false);

    try {
      const { order, replayed } = await orderService.create(payload, key);
      clearCheckoutKey();
      refresh().catch(() => {}); // purchased items were removed from the cart server-side
      if (replayed) toast.info('This order had already been placed — showing your existing order. You were not charged twice.');
      else toast.success('Order placed! We are confirming payment and reserving your items.');
      navigate(`/orders/${order.id}`, { replace: true, state: { justPlaced: true, replayed } });
    } catch (err) {
      const code = getErrorCode(err);
      const status = err.response?.status;
      if (isNetworkOrTimeout(err) || status >= 500) {
        // Outcome unknown or transient: keep the key so a retry is safe.
        setCanRetry(true);
        setError(`${getErrorMessage(err)} Your order may or may not have been placed — press “Retry safely”; it reuses the same request key, so you will not be charged twice.`);
      } else if (code === 'REQUEST_IN_PROGRESS') {
        setCanRetry(true);
        setError('Your order is still being processed. Wait a moment and press “Retry safely”.');
      } else {
        // Definitive business failure (e.g. out of stock). This operation is over.
        clearCheckoutKey();
        setError(getErrorMessage(err));
        await refresh().catch(() => {});
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = (event) => {
    event.preventDefault();
    if (!submitting) placeOrder();
  };

  const set = (field) => (e) => setAddress((a) => ({ ...a, [field]: e.target.value }));

  return (
    <div className="container page">
      <div className="page-head">
        <h1>Checkout</h1>
        <Link to="/cart">← Back to cart</Link>
      </div>

      <form className="checkout-layout" onSubmit={onSubmit} noValidate>
        <section className="card">
          <h2>Shipping address</h2>
          <div className="form-grid">
            {ADDRESS_FIELDS.map(([name, label, autoComplete]) => (
              <label key={name} className={`field ${name.startsWith('addressLine') ? 'span-2' : ''}`}>
                <span>{label}</span>
                <input value={address[name]} autoComplete={autoComplete} onChange={set(name)} disabled={submitting} aria-invalid={Boolean(fieldErrors[name])} />
                {fieldErrors[name] && <small className="field-error">{fieldErrors[name]}</small>}
              </label>
            ))}
          </div>

          <h2>Payment</h2>
          <div className="payment-option">
            <input type="radio" checked readOnly id="pay-sim" />
            <label htmlFor="pay-sim">
              <strong>Simulated payment</strong>
              <span className="muted small">Demo gateway — no card details are collected and no real money is charged.</span>
            </label>
          </div>
        </section>

        <aside className="card summary">
          <h2>Your order</h2>
          {items.map((item) => (
            <div key={item.productId} className="summary-row">
              <span>{item.quantity} × {item.name}</span>
              <span>{formatPrice(item.lineTotal)}</span>
            </div>
          ))}
          <div className="summary-row"><span>Delivery</span><span className="text-success">Free</span></div>
          <div className="summary-row total"><span>Total</span><span>{formatPrice(cart.subtotal)}</span></div>

          <ErrorMessage message={error} />
          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={submitting}>
            {submitting ? 'Placing order…' : canRetry ? 'Retry safely' : `Place order · ${formatPrice(cart.subtotal)}`}
          </button>
          {activeKey && (
            <p className="muted small idem-key" title="Sent as the Idempotency-Key header">
              Request key: <code>{activeKey}</code>
            </p>
          )}
        </aside>
      </form>
    </div>
  );
}
