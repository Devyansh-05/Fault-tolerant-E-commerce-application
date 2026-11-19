import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ProductImage from './ProductImage.jsx';
import { formatPrice } from '../utils/format.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCart } from '../context/CartContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { getErrorMessage } from '../utils/errors.js';

export default function ProductCard({ product }) {
  const { isAuthenticated } = useAuth();
  const { addItem } = useCart();
  const toast = useToast();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const outOfStock = product.stock === 0;

  const onAdd = async () => {
    if (!isAuthenticated) {
      navigate('/login', { state: { from: `/products/${product.id}` } });
      return;
    }
    setAdding(true);
    try {
      await addItem(product.id, 1);
      toast.success(`${product.name} added to cart`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <article className="product-card">
      <Link to={`/products/${product.id}`} className="product-card-media">
        <ProductImage src={product.image} alt={product.name} />
        {outOfStock && <span className="chip chip-danger product-chip">Out of stock</span>}
        {!outOfStock && product.stock <= 5 && <span className="chip chip-warning product-chip">Only {product.stock} left</span>}
      </Link>
      <div className="product-card-body">
        <span className="product-category">{product.category}</span>
        <Link to={`/products/${product.id}`} className="product-name">{product.name}</Link>
        <div className="product-card-footer">
          <span className="price">{formatPrice(product.price)}</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={outOfStock || adding} onClick={onAdd}>
            {adding ? 'Adding…' : 'Add to cart'}
          </button>
        </div>
      </div>
    </article>
  );
}
