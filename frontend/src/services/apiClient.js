import axios from 'axios';

const TOKEN_KEY = 'shopsphere.token';

export const tokenStorage = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (token) => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage unavailable */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
  },
};

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use((request) => {
  const token = tokenStorage.get();
  if (token) request.headers.Authorization = `Bearer ${token}`;
  return request;
});

// Lets the AuthContext react to an expired/invalid session anywhere in the app.
let unauthorizedHandler = null;
export const onUnauthorized = (handler) => {
  unauthorizedHandler = handler;
};

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const code = error.response?.data?.error?.code;
    if (error.response?.status === 401 && (code === 'INVALID_TOKEN' || code === 'AUTH_REQUIRED') && tokenStorage.get()) {
      unauthorizedHandler?.();
    }
    return Promise.reject(error);
  }
);

/** Extracts the `data` payload of the standard { success, data } envelope. */
export const unwrap = (response) => response.data.data;
