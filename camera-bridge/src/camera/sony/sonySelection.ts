import { SonyBackendError, SonyDevice } from './SonyBackend';

export interface SonySelectionSettings { MODEL?: string; DEVICE_ID?: string; CONNECTION?: string }

/**
 * Deterministic camera choice. Filters by the configured model / device id / connection; never by position.
 * 0 matches -> NO_CAMERA_FOUND; 1 -> that camera; >1 -> MULTIPLE_CAMERAS (the operator must set DEVICE_ID).
 */
export function selectCamera(devices: readonly SonyDevice[], s: SonySelectionSettings): SonyDevice {
  const match = devices.filter((d) =>
    (!s.DEVICE_ID || d.id === s.DEVICE_ID) &&
    (!s.MODEL || d.model.toLowerCase() === s.MODEL.toLowerCase()) &&
    (!s.CONNECTION || d.connection === s.CONNECTION));
  if (match.length === 0) throw new SonyBackendError('NO_CAMERA_FOUND');
  if (match.length > 1) throw new SonyBackendError('MULTIPLE_CAMERAS');
  return match[0];
}
