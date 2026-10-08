import pkg from '../package.json';

/** Single source of truth for the bridge version: package.json. */
export const BRIDGE_VERSION: string = pkg.version;
