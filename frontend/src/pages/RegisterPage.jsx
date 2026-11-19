import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { ErrorMessage } from '../components/Feedback.jsx';
import { getErrorMessage } from '../utils/errors.js';

export default function RegisterPage() {
  const { register, isAuthenticated } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.from || '/';

  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) return <Navigate to={redirectTo} replace />;

  const validateForm = () => {
    const next = {};
    if (form.name.trim().length < 2) next.name = 'Name must be at least 2 characters';
    if (!/^\S+@\S+\.\S+$/.test(form.email)) next.email = 'Enter a valid email address';
    if (form.password.length < 8 || !/[A-Za-z]/.test(form.password) || !/\d/.test(form.password)) {
      next.password = 'At least 8 characters, including a letter and a number';
    }
    if (form.password !== form.confirmPassword) next.confirmPassword = 'Passwords do not match';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    setServerError('');
    if (!validateForm()) return;
    setSubmitting(true);
    try {
      await register({ name: form.name, email: form.email, password: form.password });
      toast.success('Account created — welcome to ShopSphere!');
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setServerError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const field = (name, label, type, autoComplete) => (
    <label className="field">
      <span>{label}</span>
      <input type={type} autoComplete={autoComplete} value={form[name]} onChange={set(name)} aria-invalid={Boolean(errors[name])} />
      {errors[name] && <small className="field-error">{errors[name]}</small>}
    </label>
  );

  return (
    <div className="container auth-page">
      <form className="card auth-card" onSubmit={onSubmit} noValidate>
        <h1>Create account</h1>
        <p className="muted">Join ShopSphere in a few seconds.</p>
        <ErrorMessage message={serverError} />
        {field('name', 'Full name', 'text', 'name')}
        {field('email', 'Email', 'email', 'email')}
        {field('password', 'Password', 'password', 'new-password')}
        {field('confirmPassword', 'Confirm password', 'password', 'new-password')}
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
        <p className="muted center">
          Already have an account? <Link to="/login" state={location.state}>Log in</Link>
        </p>
      </form>
    </div>
  );
}
