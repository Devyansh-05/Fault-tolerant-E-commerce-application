import { useEffect, useState } from 'react';
import Pagination from '../../components/Pagination.jsx';
import ProductImage from '../../components/ProductImage.jsx';
import { ErrorMessage, Spinner } from '../../components/Feedback.jsx';
import { productService } from '../../services/productService.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatPrice } from '../../utils/format.js';
import { getErrorMessage } from '../../utils/errors.js';

const EMPTY_FORM = { name: '', description: '', price: '', category: '', image: '', stock: '' };

function toPayload(form) {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    price: Number(form.price),
    category: form.category.trim(),
    image: form.image.trim(),
    stock: Number(form.stock),
  };
}

function validate(form) {
  const errors = {};
  if (form.name.trim().length < 2) errors.name = 'Name is required';
  if (form.category.trim().length < 2) errors.category = 'Category is required';
  if (!/^\d+(\.\d{1,2})?$/.test(String(form.price).trim())) errors.price = 'Enter a valid price (max 2 decimals)';
  if (!/^\d+$/.test(String(form.stock).trim())) errors.stock = 'Stock must be a whole number ≥ 0';
  return errors;
}

export default function AdminProductsPage() {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ products: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [editingId, setEditingId] = useState(null); // null = closed, 'new' = create
  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    productService
      .list({ page, limit: 10, sort: 'newest' })
      .then(setData)
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [page, reload]);

  const openCreate = () => {
    setEditingId('new');
    setForm(EMPTY_FORM);
    setFormErrors({});
  };
  const openEdit = (p) => {
    setEditingId(p.id);
    setForm({ name: p.name, description: p.description, price: String(p.price), category: p.category, image: p.image, stock: String(p.stock) });
    setFormErrors({});
  };

  const onSave = async (event) => {
    event.preventDefault();
    const errors = validate(form);
    setFormErrors(errors);
    if (Object.keys(errors).length) return;
    setSaving(true);
    try {
      if (editingId === 'new') await productService.create(toPayload(form));
      else await productService.update(editingId, toPayload(form));
      toast.success(editingId === 'new' ? 'Product created' : 'Product updated');
      setEditingId(null);
      setReload((r) => r + 1);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (p) => {
    if (!window.confirm(`Delete "${p.name}"? It will be removed from the catalogue.`)) return;
    try {
      await productService.remove(p.id);
      toast.success('Product deleted');
      setReload((r) => r + 1);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const input = (name, label, props = {}) => (
    <label className={`field ${props.wide ? 'span-2' : ''}`}>
      <span>{label}</span>
      {props.textarea ? (
        <textarea rows={3} value={form[name]} onChange={set(name)} />
      ) : (
        <input value={form[name]} onChange={set(name)} inputMode={props.inputMode} placeholder={props.placeholder} />
      )}
      {formErrors[name] && <small className="field-error">{formErrors[name]}</small>}
    </label>
  );

  return (
    <>
      <div className="page-head">
        <h1>Products</h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={openCreate}>+ New product</button>
      </div>

      {editingId && (
        <form className="card admin-form" onSubmit={onSave} noValidate>
          <h2>{editingId === 'new' ? 'New product' : 'Edit product'}</h2>
          <div className="form-grid">
            {input('name', 'Name', { wide: true })}
            {input('category', 'Category')}
            {input('price', 'Price (₹)', { inputMode: 'decimal' })}
            {input('stock', 'Stock', { inputMode: 'numeric' })}
            {input('image', 'Image URL or path', { placeholder: '/images/products/electronics.svg' })}
            {input('description', 'Description', { wide: true, textarea: true })}
          </div>
          <div className="actions-row">
            <button type="button" className="btn btn-ghost" onClick={() => setEditingId(null)} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save product'}</button>
          </div>
        </form>
      )}

      <ErrorMessage message={error} onRetry={() => setReload((r) => r + 1)} />
      {loading ? (
        <Spinner />
      ) : (
        <section className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th></th><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th></th></tr>
              </thead>
              <tbody>
                {data.products.map((p) => (
                  <tr key={p.id}>
                    <td><div className="table-thumb"><ProductImage src={p.image} alt={p.name} /></div></td>
                    <td>{p.name}</td>
                    <td>{p.category}</td>
                    <td>{formatPrice(p.price)}</td>
                    <td className={p.stock === 0 ? 'text-danger' : ''}>{p.stock}</td>
                    <td className="nowrap">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEdit(p)}>Edit</button>
                      <button type="button" className="btn btn-ghost btn-sm text-danger" onClick={() => onDelete(p)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={data.pagination?.totalPages} onChange={setPage} />
        </section>
      )}
    </>
  );
}
