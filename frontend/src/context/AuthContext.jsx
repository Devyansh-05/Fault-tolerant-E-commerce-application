import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authService } from '../services/authService.js';
import { onUnauthorized, tokenStorage } from '../services/apiClient.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);

  const logout = useCallback(() => {
    tokenStorage.clear();
    setUser(null);
  }, []);

  // Restore the session from a stored token on first load.
  useEffect(() => {
    onUnauthorized(logout);
    if (!tokenStorage.get()) {
      setInitializing(false);
      return;
    }
    authService
      .me()
      .then(({ user: profile }) => setUser(profile))
      .catch(() => logout())
      .finally(() => setInitializing(false));
  }, [logout]);

  const handleAuth = useCallback(({ user: profile, token }) => {
    tokenStorage.set(token);
    setUser(profile);
    return profile;
  }, []);

  const value = useMemo(
    () => ({
      user,
      initializing,
      isAuthenticated: Boolean(user),
      isAdmin: user?.role === 'ADMIN',
      login: (credentials) => authService.login(credentials).then(handleAuth),
      register: (details) => authService.register(details).then(handleAuth),
      logout,
    }),
    [user, initializing, handleAuth, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
