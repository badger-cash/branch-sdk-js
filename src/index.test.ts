import { describe, expect, it } from 'vitest';

import * as sdk from './index.js';

// A smoke test rather than filler. It is what proves the scaffold is actually
// wired together: vitest resolves TypeScript through the same config the build
// uses, and the entry point is importable. Everything after this can assume
// the toolchain works and test its own behaviour instead.
describe('package entry point', () => {
  it('is importable', () => {
    expect(sdk).toBeTypeOf('object');
  });
});
