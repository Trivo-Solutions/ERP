import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../store/auth.store';

// In dev the Vite proxy rewrites /api → http://localhost:3001/api.
// In production builds, VITE_API_URL must be set (e.g. https://erp.company.com).
// Vite only exposes env vars prefixed with VITE_ to client bundles.
const BASE_URL = (import.meta.env.VITE_API_URL ?? '') + '/api/v1';

export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT token
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = useAuthStore.getState().accessToken;
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 → refresh token
let refreshing: Promise<string> | null = null;

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      const { refreshToken, setAccessToken, logout } = useAuthStore.getState();

      if (!refreshToken) { logout(); return Promise.reject(error); }

      if (!refreshing) {
        refreshing = api
          // `_retry: true` marks the refresh call itself as already-retried. Without it, a 401 from /auth/refresh (expired
          // token, or a SUSPENDED company) re-enters this interceptor, which awaits the very `refreshing` promise it is
          // part of — a promise that then never settles, so logout() never runs and the user is stranded in the app shell.
          .post<{ data: { accessToken: string } }>('/auth/refresh', { refreshToken }, { _retry: true } as any)
          .then((res) => {
            const newToken = res.data.data.accessToken;
            setAccessToken(newToken);
            refreshing = null;
            return newToken;
          })
          .catch(() => { logout(); refreshing = null; return Promise.reject(error); });
      }

      const newToken = await refreshing;
      if (originalRequest.headers) originalRequest.headers.Authorization = `Bearer ${newToken}`;
      return api(originalRequest);
    }

    return Promise.reject(error);
  }
);

// Typed API helpers
// The server uses two response shapes:
//   • Single/array endpoints: { success: true, data: X }       → return X
//   • Paginated list endpoints: { success: true, designs: [], total: N } → return the whole body minus `success`
// This helper handles both by preferring `.data` when present, otherwise returning the spread payload.
export const apiGet = <T>(url: string, params?: object) =>
  api.get<{ success: boolean; data?: T } & Record<string, unknown>>(url, { params }).then((r) => {
    const { success: _s, ...rest } = r.data;
    return (rest.data !== undefined ? rest.data : rest) as T;
  });

export const apiPost = <T>(url: string, data?: object) =>
  api.post<{ success: boolean; data: T }>(url, data).then((r) => r.data.data);

export const apiPatch = <T>(url: string, data?: object) =>
  api.patch<{ success: boolean; data: T }>(url, data).then((r) => r.data.data);

export const apiPut = <T>(url: string, data?: object) =>
  api.put<{ success: boolean; data: T }>(url, data).then((r) => r.data.data);

export const apiDelete = <T>(url: string) =>
  api.delete<{ success: boolean; data: T }>(url).then((r) => r.data.data);
