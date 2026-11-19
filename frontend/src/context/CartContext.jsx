import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { cartService } from '../services/cartService.js';
import { useAuth } from './AuthContext.jsx';

const EMPTY_CART = { items: [], itemCount: 0, subtotal: 0, hasUnavailableItems: false };
const CartContext = createContext(null);

/** Server-side cart (always priced by the backend); this context only mirrors it. */
export function CartProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const [cart, setCart] = useState(EMPTY_CART);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setCart(EMPTY_CART);
      return EMPTY_CART;
    }
    setLoading(true);
    try {
      const fresh = await cartService.get();
      setCart(fresh);
      return fresh;
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    refresh().catch(() => setCart(EMPTY_CART));
  }, [refresh]);

  const value = useMemo(
    () => ({
      cart,
      loading,
      refresh,
      addItem: async (productId, quantity) => setCart(await cartService.add(productId, quantity)),
      updateItem: async (productId, quantity) => setCart(await cartService.update(productId, quantity)),
      removeItem: async (productId) => setCart(await cartService.remove(productId)),
      clear: async () => setCart(await cartService.clear()),
    }),
    [cart, loading, refresh]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
