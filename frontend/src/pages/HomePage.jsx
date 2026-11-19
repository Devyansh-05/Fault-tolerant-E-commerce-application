import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ProductCard from '../components/ProductCard.jsx';
import { ErrorMessage, Spinner } from '../components/Feedback.jsx';
import { productService } from '../services/productService.js';
import { getErrorMessage } from '../utils/errors.js';

export default function HomePage() {
  const [featured, setFeatured] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true);
    setError('');
    Promise.all([productService.list({ limit: 8, sort: 'newest' }), productService.categories()])
      .then(([list, cats]) => {
        setFeatured(list.products);
        setCategories(cats);
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <>
      <section className="hero">
        <div className="container hero-inner">
          <div>
            <span className="hero-eyebrow">New season · Free delivery on every order</span>
            <h1>Everything you love, delivered reliably.</h1>
            <p>Shop electronics, fashion, home essentials and more. Every order is protected against duplicate charges.</p>
            <div className="hero-actions">
              <Link to="/products" className="btn btn-primary btn-lg">Shop now</Link>
              <Link to="/register" className="btn btn-light btn-lg">Create account</Link>
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <img src="/images/products/electronics.svg" alt="" />
            <img src="/images/products/fashion.svg" alt="" />
            <img src="/images/products/home.svg" alt="" />
          </div>
        </div>
      </section>

      <div className="container">
        <ErrorMessage message={error} onRetry={load} />

        {categories.length > 0 && (
          <section className="section">
            <h2 className="section-title">Shop by category</h2>
            <div className="category-grid">
              {categories.map((category) => (
                <Link key={category} to={`/products?category=${encodeURIComponent(category)}`} className="category-tile">
                  {category}
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="section">
          <div className="section-head">
            <h2 className="section-title">New arrivals</h2>
            <Link to="/products">View all →</Link>
          </div>
          {loading ? (
            <Spinner />
          ) : (
            <div className="product-grid">
              {featured.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
