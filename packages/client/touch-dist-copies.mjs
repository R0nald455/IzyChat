import { utimesSync } from 'node:fs';
import { join } from 'node:path';

/** Copied assets keep source mtimes; designMetadataIsFresh compares dist to package.json. */
const now = new Date();
for (const file of ['tokens.css', 'defaults.css', 'fonts.css']) {
  try {
    utimesSync(join('dist', file), now, now);
  } catch {
    // Optional copy targets — absent when the build did not emit them.
  }
}
