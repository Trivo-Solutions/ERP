import { ConfigError } from '../config';
import type { CameraProviderKind } from './createProvider';

// Provider-specific settings travel as CAMERA_OPT_<NAME> and stay a plain string map all the way to the provider; the
// generic interface (types.ts) and the ERP know nothing about them. Each provider declares what it accepts, so a typo
// is a startup error rather than a silently ignored setting.
export type ProviderOptions = Record<string, string>;

// Absolute path of a native helper executable. Trusted LOCAL configuration only (never from the ERP); the backend re-validates
// that it is an existing regular file before ever spawning it.
const HELPER_PATH = /^(?:[A-Za-z]:[\\/]|\/)[^\0"<>|?*]{1,240}$/;

const ACCEPTED: Record<CameraProviderKind, Record<string, RegExp>> = {
  mock: {},
  // webcam: HELPER_PATH is the webcam helper. auto: HELPER_PATH is the webcam helper, SONY_HELPER_PATH the Sony one.
  webcam: { HELPER_PATH },
  auto: { HELPER_PATH, SONY_HELPER_PATH: HELPER_PATH },
  sony: {
    MODEL: /^[A-Za-z0-9 ._-]{1,40}$/,
    DEVICE_ID: /^[A-Za-z0-9 ._:-]{1,64}$/,
    CONNECTION: /^(usb|network)$/,
    HELPER_PATH,
  },
};

export function parseProviderOptions(kind: CameraProviderKind, env: NodeJS.ProcessEnv): ProviderOptions {
  const out: ProviderOptions = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^CAMERA_OPT_(.+)$/.exec(k);
    if (!m || v === undefined) continue;
    const rule = ACCEPTED[kind][m[1]];
    if (!rule) throw new ConfigError(`${k} is not a setting of the "${kind}" camera provider`);
    if (!rule.test(v.trim())) throw new ConfigError(`${k} has an invalid value`);
    out[m[1]] = v.trim();
  }
  return out;
}
