import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';
import { describe, expect, it } from 'vitest';

/**
 * Node 18 is a supported target, not a leftover.
 *
 * This SDK is going into government infrastructure, and government
 * infrastructure upgrades late. A dependency that quietly requires Node 20
 * does not fail here -- it fails on someone else's server, after install, at
 * a point where the fix is "upgrade your runtime" and the answer is no.
 *
 * So the floor is asserted rather than assumed. The check walks the whole
 * production tree from the lockfile, transitive dependencies included,
 * because the risk is not the package we choose deliberately. It is the third
 * one down that a chosen package pulled in.
 *
 * Dev dependencies are exempt. They do not ship: what a contributor needs to
 * run the linter has no bearing on what a consumer needs to run the SDK. That
 * distinction is the whole reason this floor is affordable -- current ESLint
 * and TypeScript majors have already left Node 18, and none of that reaches
 * anyone who installs this package.
 */

const SUPPORTED_FLOOR = '18.0.0';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

interface LockEntry {
  dev?: boolean;
  optional?: boolean;
  engines?: { node?: string };
}

function readLock(): Record<string, LockEntry> {
  const raw = readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8');
  return (JSON.parse(raw) as { packages?: Record<string, LockEntry> }).packages ?? {};
}

describe('the Node 18 support floor', () => {
  it('is what package.json promises', () => {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    const declared = pkg.engines?.node;
    expect(declared).toBeDefined();
    expect(semver.satisfies(SUPPORTED_FLOOR, declared!)).toBe(true);
  });

  it('holds across every shipped dependency, transitive included', () => {
    const offenders: string[] = [];

    for (const [location, entry] of Object.entries(readLock())) {
      // The root entry re-states package.json, covered by the test above.
      if (location === '') continue;
      // Dev-only, and optional packages whose absence is not a failure.
      if (entry.dev === true || entry.optional === true) continue;

      const range = entry.engines?.node;
      if (range === undefined) continue;

      if (!semver.satisfies(SUPPORTED_FLOOR, range)) {
        offenders.push(`${location} requires ${range}`);
      }
    }

    // Named in the failure rather than counted, so the message says which
    // dependency broke the floor and what it wants instead.
    expect(offenders).toEqual([]);
  });
});
