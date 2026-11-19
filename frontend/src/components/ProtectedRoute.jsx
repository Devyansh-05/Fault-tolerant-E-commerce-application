import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Spinner } from './Feedback.jsx';

/** Guards child routes. With `role`, also requires that role (e.g. ADMIN). */
export default function ProtectedRoute({ role }) {
  const { isAuthenticated, initializing, user } = useAuth();
  const location = useLocation();

  if (initializing) return <Spinner label="Checking your session…" />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return <Outlet />;
}
