import { useEffect, useCallback, useSyncExternalStore } from 'react';
import { useAuthStore } from '../store/auth.store';
import { closeSocket, ensureSocketFor, getSocket, subscribeSocket } from '../api/socketRegistry';

export function useSocket() {
  const token = useAuthStore((s) => s.accessToken);
  // Who this session belongs to. The socket is opened for (and only for) this identity — see socketRegistry.ts.
  const identity = useAuthStore((s) => (s.company?.id && s.user?.companyUserId ? `${s.company.id}:${s.user.companyUserId}` : null));

  // Reactive: the socket is opened in the effect below, after first render — consumers must re-render when it appears.
  const socket = useSyncExternalStore(subscribeSocket, getSocket);

  useEffect(() => {
    if (!token || !identity) { closeSocket(); return; }
    ensureSocketFor(identity, token);
  }, [token, identity]);

  const subscribe = useCallback((event: string, handler: (data: any) => void) => {
    socket?.on(event, handler);
    return () => { socket?.off(event, handler); };
  }, [socket]);

  const emit = useCallback((event: string, data?: any) => {
    socket?.emit(event, data);
  }, [socket]);

  return { socket, subscribe, emit };
}

export function useScaleReading(deviceId: string, onReading: (weight: number) => void) {
  const { subscribe } = useSocket();

  useEffect(() => {
    return subscribe(`scale:${deviceId}`, ({ weight }: { weight: number }) => {
      onReading(weight);
    });
  }, [deviceId, onReading, subscribe]);
}

export function useJobCardUpdates(jobCardId: string, onUpdate: (data: any) => void) {
  const { subscribe, emit } = useSocket();

  useEffect(() => {
    emit('subscribe:jobcard', jobCardId);
    return subscribe('jobcard:update', onUpdate);
  }, [jobCardId, onUpdate, subscribe, emit]);
}
