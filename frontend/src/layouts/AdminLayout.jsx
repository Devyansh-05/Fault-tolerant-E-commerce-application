import { NavLink, Outlet } from 'react-router-dom';

/**
 * Admin area shell (every route below is wrapped in <ProtectedRoute role="ADMIN" />, and every
 * admin API is additionally protected on the backend). Add a section by appending here and
 * adding a child route in App.jsx.
 */
export const ADMIN_NAV = [
  { group: 'Store' },
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/products', label: 'Products' },
  { group: 'Reliability' },
  { to: '/admin/testing', label: 'Testing Panel' },
  { to: '/admin/reliability', label: 'Reliability Dashboard' },
  { to: '/admin/dlq', label: 'Dead Letter Queue' },
];

export default function AdminLayout() {
  return (
    <div className="container admin-layout">
      <aside className="admin-sidebar">
        <nav>
          {ADMIN_NAV.map((item) =>
            item.group ? (
              <p key={item.group} className="admin-sidebar-title">{item.group}</p>
            ) : (
              <NavLink key={item.to} to={item.to} end={item.end}>
                {item.label}
              </NavLink>
            )
          )}
        </nav>
      </aside>
      <section className="admin-content">
        <Outlet />
      </section>
    </div>
  );
}
