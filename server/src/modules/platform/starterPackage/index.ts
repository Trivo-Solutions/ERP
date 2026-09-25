import type { StarterPackageDefinition } from './types';
import { validateStarterPackage } from './validate';
import { STARTER_PACKAGE_V1 } from './v1';

export * from './types';
export { validateStarterPackage, collectStarterPackageErrors } from './validate';
export { applyStarterPackage, type StarterApplyCounts } from './apply';

// The registry of released Starter Packages. A package is immutable once released; a change is a
// NEW version (a new file + one line here). Provisioning picks a version explicitly (default:
// LATEST) and the company records it. Nothing ever re-applies a package to an existing company.
const REGISTRY = new Map<number, StarterPackageDefinition>();

export function registerStarterPackage(pkg: StarterPackageDefinition): void {
  validateStarterPackage(pkg);
  if (REGISTRY.has(pkg.version)) throw new Error(`Starter Package v${pkg.version} is already registered (packages are immutable — release a new version instead)`);
  REGISTRY.set(pkg.version, pkg);
}

/** Test-only: lets a test register a throw-away version and remove it again. */
export function _unregisterStarterPackageForTests(version: number): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('_unregisterStarterPackageForTests is test-only');
  REGISTRY.delete(version);
}

registerStarterPackage(STARTER_PACKAGE_V1);

export function listStarterPackageVersions(): number[] {
  return [...REGISTRY.keys()].sort((a, b) => a - b);
}

export function latestStarterPackageVersion(): number {
  return Math.max(...REGISTRY.keys());
}

export function getStarterPackage(version: number = latestStarterPackageVersion()): StarterPackageDefinition {
  const pkg = REGISTRY.get(version);
  if (!pkg) throw new Error(`Unknown Starter Package version ${version}`);
  return pkg;
}

export { STARTER_PACKAGE_V1 };
