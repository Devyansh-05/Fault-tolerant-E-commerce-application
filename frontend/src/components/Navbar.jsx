import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useCart } from '../context/CartContext.jsx';

export default function Navbar() {
  const { user, isAuthenticated, isAdmin, logout } = useAuth();
  const { cart } = useCart();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  const onSearch = (event) => {
    event.preventDefault();
    const q = query.trim();
    navigate(q ? `/products?q=${encodeURIComponent(q)}` : '/products');
    setMenuOpen(false);
  };

  const onLogout = () => {
    logout();
    setMenuOpen(false);
    navigate('/');
  };

  return (
    <header className="navbar">
      <div className="container navbar-inner">
        <Link to="/" className="brand" onClick={() => setMenuOpen(false)}>
          <span className="brand-mark">S</span>
          ShopSphere
        </Link>

        <form className="nav-search" onSubmit={onSearch} role="search">
          <input
            type="search"
            placeholder="Search products, categories..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search products"
          />
          <button type="submit" className="btn btn-primary btn-sm">Search</button>
        </form>

        <button type="button" className="nav-toggle" aria-label="Toggle menu" onClick={() => setMenuOpen((o) => !o)}>
          ☰
        </button>

        <nav className={`nav-links ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
          <NavLink to="/products">Shop</NavLink>
          {isAuthenticated && <NavLink to="/orders">My Orders</NavLink>}
          {isAdmin && <NavLink to="/admin">Admin</NavLink>}
          {isAuthenticated ? (
            <>
              <span className="nav-user" title={user.email}>Hi, {user.name.split(' ')[0]}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>Logout</button>
            </>
          ) : (
            <>
              <NavLink to="/login">Login</NavLink>
              <Link to="/register" className="btn btn-primary btn-sm">Sign up</Link>
            </>
          )}
          <NavLink to="/cart" className="cart-link" aria-label={`Cart with ${cart.itemCount} items`}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path fill="currentColor" d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM5.2 4l.4 2H20a1 1 0 0 1 1 1.2l-1.4 7A2 2 0 0 1 17.6 16H8.1a2 2 0 0 1-2-1.6L3.6 3H2V1h3a1 1 0 0 1 1 .8L6.2 4Z" />
            </svg>
            {cart.itemCount > 0 && <span className="cart-badge">{cart.itemCount}</span>}
          </NavLink>
        </nav>
      </div>
    </header>
  );
}
