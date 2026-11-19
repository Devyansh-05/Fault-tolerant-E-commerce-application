import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { ErrorMessage } from '../components/Feedback.jsx';
import { getErrorMessage } from '../utils/errors.js';

export default function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.from || '/';

  const [form, setForm] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) return <Navigate to={redirectTo} replace />;

  const validateForm = () => {
    const next = {};
    if (!/^\S+@\S+\.\S+$/.test(form.email)) next.email = 'Enter a valid email address';
    if (!form.password) next.password = 'Password is required';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    setServerError('');
    if (!validateForm()) return;
    setSubmitting(true);
    try {
      const user = await login(form);
      toast.success(`Welcome back, ${user.name.split(' ')[0]}!`);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setServerError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  return (
    <div className="container auth-page">
      <form className="card auth-card" onSubmit={onSubmit} noValidate>
        <h1>Log in</h1>
        <p className="muted">Welcome back to ShopSphere.</p>
        <ErrorMessage message={serverError} />
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" value={form.email} onChange={set('email')} aria-invalid={Boolean(errors.email)} />
          {errors.email && <small className="field-error">{errors.email}</small>}
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={form.password} onChange={set('password')} aria-invalid={Boolean(errors.password)} />
          {errors.password && <small className="field-error">{errors.password}</small>}
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? 'Logging in…' : 'Log in'}
        </button>
        <p className="muted center">
          New here? <Link to="/register" state={location.state}>Create an account</Link>
        </p>
      </form>
    </div>
  );
}
