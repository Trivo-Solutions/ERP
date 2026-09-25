import { useState, useCallback, useRef, useEffect } from 'react';
import { apiPost } from '../api/client';

export interface ScaleReading {
  weight: number;
  unit: string;
  isStable: boolean;
  timestamp: Date;
  rawLine: string;
}

interface UseWebSerialOptions {
  baudRate?: number;
  onReading?: (reading: ScaleReading) => void;
  deviceId?: string;
}

// Parses AND/Mettler Toledo RS232 standard output format:
// "ST,GS,+  123.456 g" (stable gross) or "US,GS,+  123.456 g" (unstable)
function parseScaleLine(line: string): ScaleReading | null {
  const normalized = line.trim();
  if (!normalized) return null;

  // Standard AND/MT format
  const match = normalized.match(/^([A-Z]{2}),([A-Z]{2}),([+-])\s*([\d.]+)\s*([a-zA-Z]+)/);
  if (match) {
    const [, stability, , sign, value, unit] = match;
    const weight = parseFloat(`${sign}${value}`);
    if (isNaN(weight)) return null;
    return { weight, unit: unit.toLowerCase(), isStable: stability === 'ST', timestamp: new Date(), rawLine: normalized };
  }

  // Fallback: bare numeric line like "  15.3456\r\n"
  const numeric = normalized.match(/^([+-]?\s*[\d.]+)\s*([a-zA-Z]*)/);
  if (numeric) {
    const weight = parseFloat(numeric[1].replace(/\s/g, ''));
    if (!isNaN(weight)) {
      return { weight, unit: numeric[2].toLowerCase() || 'g', isStable: true, timestamp: new Date(), rawLine: normalized };
    }
  }

  return null;
}

export function useWebSerial({ baudRate = 9600, onReading, deviceId = 'web-serial' }: UseWebSerialOptions = {}) {
  const [isSupported] = useState(() => 'serial' in navigator);
  const [isConnected, setIsConnected] = useState(false);
  const [lastReading, setLastReading] = useState<ScaleReading | null>(null);
  const [error, setError] = useState<string | null>(null);

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const disconnect = useCallback(async () => {
    abortRef.current?.abort();
    try {
      await readerRef.current?.cancel();
    } catch {}
    try {
      await portRef.current?.close();
    } catch {}
    readerRef.current = null;
    portRef.current = null;
    setIsConnected(false);
  }, []);

  const connect = useCallback(async () => {
    if (!isSupported) {
      setError('Web Serial API not supported. Use Chrome/Edge 89+ on a secure origin.');
      return;
    }

    try {
      setError(null);
      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });

      portRef.current = port;
      setIsConnected(true);

      abortRef.current = new AbortController();
      const decoder = new TextDecoderStream();
      port.readable.pipeTo(decoder.writable, { signal: abortRef.current.signal }).catch(() => {});

      const reader = decoder.readable.getReader();
      readerRef.current = reader;

      let buffer = '';
      const readLoop = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;

            const lines = buffer.split(/\r\n|\r|\n/);
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              const reading = parseScaleLine(line);
              if (reading && reading.isStable) {
                setLastReading(reading);
                onReading?.(reading);
                // Report stable reading to backend for WS broadcast
                apiPost(`/hardware/scales/${deviceId}/simulate`, { weight: reading.weight }).catch(() => {});
              }
            }
          }
        } catch (err: any) {
          if (err.name !== 'AbortError') {
            setError(`Scale read error: ${err.message}`);
            setIsConnected(false);
          }
        }
      };

      readLoop();
    } catch (err: any) {
      if (err.name !== 'NotFoundError') {
        setError(`Failed to connect: ${err.message}`);
      }
      setIsConnected(false);
    }
  }, [isSupported, baudRate, onReading, deviceId]);

  // Cleanup on unmount
  useEffect(() => () => { disconnect(); }, [disconnect]);

  return { isSupported, isConnected, lastReading, error, connect, disconnect };
}
