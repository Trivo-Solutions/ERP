import { io, Socket } from 'socket.io-client';

// ═══════════════════════════════════════════════════════════════════════════
// The ONE realtime connection of this browser tab — owned by exactly one signed-in identity.
//
// The server authenticates a socket ONCE, at connect, from the token in the handshake, and puts it in that
// company's rooms. So a socket must never outlive the session it was opened for: if company A logs out and
// company B logs in in the same tab, B must get its OWN socket (authenticated as B), not keep riding A's — that
// would deliver A's realtime events (stock alerts, memo alerts, scale readings…) into B's session even though
// the server-side rooms are perfectly isolated.
//
// Hence: the socket records who it belongs to (`owner` = companyId:companyUserId). Any other identity — or no
// identity — closes it first. Logout, login and cross-tab session changes all call closeSocket().
// ═══════════════════════════════════════════════════════════════════════════

let socket: Socket | null = null;
let owner: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** For useSyncExternalStore: components re-render when the socket is created or closed (it is opened in an effect, i.e. AFTER first render). */
export function subscribeSocket(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSocket(): Socket | null {
  return socket;
}

export function closeSocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  const had = socket !== null;
  socket = null;
  owner = null;
  if (had) notify();
}

/** Returns the socket for this identity, opening a fresh one (and closing anyone else's) when needed. */
export function ensureSocketFor(identity: string, token: string): Socket {
  if (socket && owner === identity) return socket;
  closeSocket();
  // In dev the Vite proxy forwards /socket.io to localhost:3001.
  // In production, VITE_WS_URL (or VITE_API_URL) must point to the backend host (or the reverse proxy serves both).
  const wsUrl = import.meta.env.VITE_WS_URL ?? import.meta.env.VITE_API_URL ?? '/';
  const s = io(wsUrl, { auth: { token }, transports: ['websocket', 'polling'], autoConnect: true });
  s.on('connect', () => console.log('WS connected'));
  s.on('disconnect', () => console.log('WS disconnected'));
  s.on('connect_error', (err) => console.warn('WS error:', err.message));
  socket = s;
  owner = identity;
  notify();
  return s;
}
