import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ProductCard from '../components/ProductCard.jsx';
import Pagination from '../components/Pagination.jsx';
import { EmptyState, ErrorMessage, Spinner } from '../components/Feedback.jsx';
import { productService } from '../services/productService.js';
import { getErrorMessage } from '../utils/errors.js';
import { useDebounce } from '../hooks/useDebounce.js';

const SORT_OPTIONS = [
  ['newest', 'Newest'],
  ['price_asc', 'Price: low to high'],
  ['price_desc', 'Price: high to low'],
  ['name', 'Name A–Z'],
];

export default function ProductsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const sort = params.get('sort') ?? 'newest';
  const page = Number(params.get('page') ?? 1) || 1;

  const [search, setSearch] = useState(q);
  const debouncedSearch = useDebounce(search);
  const [categories, setCategories] = useState([]);
  const [data, setData] = useState({ products: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const update = (changes) => {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };

  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    if (debouncedSearch !== q) update({ q: debouncedSearch.trim() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  useEffect(() => {
    productService.categories().then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    productService
      .list({ q, category, sort, page, limit: 12 })
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(getErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [q, category, sort, page, reloadToken]);

  return (
    <div className="container page">
      <div className="page-head">
        <h1>{category || (q ? `Results for “${q}”` : 'All products')}</h1>
        {data.pagination && <span className="muted">{data.pagination.total} products</span>}
      </div>

      <div className="shop-layout">
        <aside className="filters card">
          <label className="field">
            <span>Search</span>
            <input type="search" value={search} placeholder="Search…" onChange={(e) => setSearch(e.target.value)} />
          </label>
          <div className="field">
            <span>Category</span>
            <div className="filter-list">
              <button type="button" className={!category ? 'active' : ''} onClick={() => update({ category: '' })}>
                All categories
              </button>
              {categories.map((c) => (
                <button key={c} type="button" className={category === c ? 'active' : ''} onClick={() => update({ category: c })}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Sort by</span>
            <select value={sort} onChange={(e) => update({ sort: e.target.value })}>
              {SORT_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </aside>

        <section>
          <ErrorMessage message={error} onRetry={() => setReloadToken((t) => t + 1)} />
          {loading ? (
            <Spinner label="Loading products…" />
          ) : data.products.length === 0 && !error ? (
            <EmptyState title="No products found" message="Try a different search or category." />
          ) : (
            <>
              <div className="product-grid">
                {data.products.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
              <Pagination
                page={page}
                totalPages={data.pagination?.totalPages}
                onChange={(p) => update({ page: String(p) })}
              />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
