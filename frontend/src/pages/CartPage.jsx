import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ProductImage from '../components/ProductImage.jsx';
import QuantityInput from '../components/QuantityInput.jsx';
import { EmptyState, Spinner } from '../components/Feedback.jsx';
import { useCart } from '../context/CartContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { formatPrice } from '../utils/format.js';
import { getErrorMessage } from '../utils/errors.js';

export default function CartPage() {
  const { cart, loading, updateItem, removeItem, clear } = useCart();
  const toast = useToast();
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState(null);

  const run = async (productId, action) => {
    setBusyId(productId);
    try {
      await action();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  if (loading && cart.items.length === 0) return <Spinner label="Loading your cart…" />;

  if (cart.items.length === 0) {
    return (
      <div className="container page">
        <EmptyState
          title="Your cart is empty"
          message="Browse the shop and add something you like."
          action={<Link to="/products" className="btn btn-primary">Start shopping</Link>}
        />
      </div>
    );
  }

  const availableItems = cart.items.filter((i) => i.isAvailable);

  return (
    <div className="container page">
      <div className="page-head">
        <h1>Shopping cart</h1>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => run('all', clear)} disabled={busyId !== null}>
          Clear cart
        </button>
      </div>

      <div className="cart-layout">
        <section className="card cart-items">
          {cart.items.map((item) => (
            <div key={item.productId} className={`cart-row ${item.isAvailable ? '' : 'unavailable'}`}>
              <Link to={`/products/${item.productId}`} className="cart-thumb">
                <ProductImage src={item.image} alt={item.name} />
              </Link>
              <div className="cart-row-info">
                <Link to={`/products/${item.productId}`} className="product-name">{item.name}</Link>
                <span className="muted small">{formatPrice(item.unitPrice)} each</span>
                {!item.isAvailable && (
                  <span className="text-danger small">
                    {item.availableStock === 0 ? 'Out of stock' : `Only ${item.availableStock} available — reduce quantity`}
                  </span>
                )}
              </div>
              <QuantityInput
                value={item.quantity}
                max={Math.max(1, Math.min(20, item.availableStock || item.quantity))}
                disabled={busyId !== null}
                onChange={(q) => run(item.productId, () => updateItem(item.productId, q))}
              />
              <span className="cart-line-total">{formatPrice(item.lineTotal)}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${item.name}`}
                disabled={busyId !== null}
                onClick={() => run(item.productId, () => removeItem(item.productId))}
              >
                ✕
              </button>
            </div>
          ))}
        </section>

        <aside className="card summary">
          <h2>Order summary</h2>
          <div className="summary-row"><span>Items ({availableItems.reduce((n, i) => n + i.quantity, 0)})</span><span>{formatPrice(cart.subtotal)}</span></div>
          <div className="summary-row"><span>Delivery</span><span className="text-success">Free</span></div>
          <div className="summary-row total"><span>Total</span><span>{formatPrice(cart.subtotal)}</span></div>
          {cart.hasUnavailableItems && <p className="small text-danger">Unavailable items will not be included in your order.</p>}
          <button type="button" className="btn btn-primary btn-block btn-lg" disabled={availableItems.length === 0} onClick={() => navigate('/checkout')}>
            Proceed to checkout
          </button>
          <p className="muted small center">Prices are confirmed by the server at checkout.</p>
        </aside>
      </div>
    </div>
  );
}
