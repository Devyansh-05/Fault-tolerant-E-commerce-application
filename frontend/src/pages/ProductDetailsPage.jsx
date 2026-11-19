import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ProductImage from '../components/ProductImage.jsx';
import QuantityInput from '../components/QuantityInput.jsx';
import { EmptyState, ErrorMessage, Spinner } from '../components/Feedback.jsx';
import { productService } from '../services/productService.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCart } from '../context/CartContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { formatPrice } from '../utils/format.js';
import { getErrorMessage } from '../utils/errors.js';

export default function ProductDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { addItem } = useCart();
  const toast = useToast();

  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError('');
    setNotFound(false);
    productService
      .get(id)
      .then(setProduct)
      .catch((err) => {
        const status = err.response?.status;
        if (status === 404 || status === 400) setNotFound(true);
        else setError(getErrorMessage(err));
      })
      .finally(() => setLoading(false));
  }, [id]);

  const onAdd = async (goToCart) => {
    if (!isAuthenticated) {
      navigate('/login', { state: { from: `/products/${id}` } });
      return;
    }
    setAdding(true);
    try {
      await addItem(product.id, quantity);
      toast.success(`${quantity} × ${product.name} added to cart`);
      if (goToCart) navigate('/cart');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  if (loading) return <Spinner label="Loading product…" />;
  if (notFound) {
    return (
      <div className="container page">
        <EmptyState title="Product not found" message="It may have been removed." action={<Link to="/products" className="btn btn-primary">Back to shop</Link>} />
      </div>
    );
  }
  if (error) return <div className="container page"><ErrorMessage message={error} /></div>;

  const outOfStock = product.stock === 0;
  return (
    <div className="container page">
      <nav className="breadcrumbs">
        <Link to="/products">Shop</Link> / <Link to={`/products?category=${encodeURIComponent(product.category)}`}>{product.category}</Link> / <span>{product.name}</span>
      </nav>
      <div className="product-detail">
        <div className="product-detail-media card">
          <ProductImage src={product.image} alt={product.name} />
        </div>
        <div className="product-detail-info">
          <span className="product-category">{product.category}</span>
          <h1>{product.name}</h1>
          <p className="price price-lg">{formatPrice(product.price)}</p>
          <p className={outOfStock ? 'text-danger' : 'text-success'}>
            {outOfStock ? 'Currently out of stock' : `In stock (${product.stock} available)`}
          </p>
          <p className="description">{product.description}</p>

          {!outOfStock && (
            <div className="buy-box">
              <QuantityInput value={quantity} max={Math.min(20, product.stock)} onChange={setQuantity} disabled={adding} />
              <button type="button" className="btn btn-primary btn-lg" disabled={adding} onClick={() => onAdd(false)}>
                {adding ? 'Adding…' : 'Add to cart'}
              </button>
              <button type="button" className="btn btn-outline btn-lg" disabled={adding} onClick={() => onAdd(true)}>
                Buy now
              </button>
            </div>
          )}
          <ul className="perks">
            <li>Free delivery</li>
            <li>Secure, simulated checkout — no real charges</li>
            <li>Duplicate-order protection on every purchase</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
