import path from 'path';
import { dataDir } from '../paths';
import { createLogger, Logger } from '../logger';
import { CameraHub } from './CameraHub';
import { CameraSource } from './discovery';
import { MockCameraProvider } from './MockCameraProvider';
import { ProviderOptions } from './providerOptions';
import { FileSelectionStore, SelectionStore } from './selectionStore';
import { HelperSonyBackend, resolveHelperPath } from './sony/HelperSonyBackend';
import { SonyBackend, SonyBackendError } from './sony/SonyBackend';
import { SonyCameraProvider } from './sony/SonyCameraProvider';
import { SonySource } from './sony/sonySource';
import { CameraProvider } from './types';
import { HelperWebcamBackend, resolveWebcamHelperPath } from './webcam/HelperWebcamBackend';
import { WebcamBackend, WebcamBackendError } from './webcam/WebcamBackend';
import { WebcamSource } from './webcam/webcamSource';

// <bridge>/native/sony/ — a station prerequisite (Sony's SDK cannot be redistributed); gitignored, never in the build.
export const DEFAULT_HELPER = path.resolve(__dirname, '..', '..', 'native', 'sony', 'trivo-sony-helper.exe');
// <bridge>/native/webcam/ — built by scripts/build-webcam.ps1 (needs no SDK); gitignored.
export const DEFAULT_WEBCAM_HELPER = path.resolve(__dirname, '..', '..', 'native', 'webcam', 'trivo-webcam-helper.exe');

export type CameraProviderKind = 'mock' | 'sony' | 'webcam' | 'auto';

/** Only constructs the backend object. The helper is spawned lazily on connect, so a station without it still starts. */
function sonyBackend(options: ProviderOptions, helperPath = options.HELPER_PATH): SonyBackend | undefined {
  let command: string;
  try { command = resolveHelperPath(helperPath, DEFAULT_HELPER); }
  catch (e) { if (e instanceof SonyBackendError) return undefined; throw e; } // undefined -> UnavailableSonyBackend (DRIVER_UNAVAILABLE)
  return new HelperSonyBackend({ command, outDir: path.join(dataDir(), 'sony-shots') });
}

function webcamBackend(options: ProviderOptions): WebcamBackend | undefined {
  let command: string;
  try { command = resolveWebcamHelperPath(options.HELPER_PATH, DEFAULT_WEBCAM_HELPER); }
  catch (e) { if (e instanceof WebcamBackendError) return undefined; throw e; }
  return new HelperWebcamBackend({ command, outDir: path.join(dataDir(), 'webcam-shots') });
}

export interface ProviderExtras {
  log?: Logger;
  /** Where an explicit camera choice is remembered (webcam/auto). Defaults to <data>/camera-selection.json. */
  selectionStore?: SelectionStore;
}

/** The sources a discovering provider offers: always the Windows webcams; `auto` also lists Sony (unavailable without its SDK). */
export function createCameraSources(kind: 'webcam' | 'auto', options: ProviderOptions = {}): CameraSource[] {
  const sources: CameraSource[] = [new WebcamSource({ makeBackend: () => webcamBackend(options) })];
  if (kind === 'auto') sources.push(new SonySource({ makeBackend: () => sonyBackend(options, options.SONY_HELPER_PATH) }));
  return sources;
}

export function createCameraProvider(kind: CameraProviderKind, options: ProviderOptions = {}, extras: ProviderExtras = {}): CameraProvider {
  if (kind === 'webcam' || kind === 'auto') {
    return new CameraHub(
      createCameraSources(kind, options),
      extras.log ?? createLogger({ sink: () => undefined }),
      extras.selectionStore ?? new FileSelectionStore(path.join(dataDir(), 'camera-selection.json')),
    );
  }
  return kind === 'sony' ? new SonyCameraProvider({ settings: options, backend: sonyBackend(options) }) : new MockCameraProvider();
}
