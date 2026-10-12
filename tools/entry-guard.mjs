import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when this module is the script Node was asked to run.
 *
 * Both sides go through realpathSync first: a checkout reached through a
 * junction (or any symlinked ancestor) spells argv[1] with the junction while
 * import.meta.url keeps the real path, and a plain string compare made the
 * CLI entry silently not run — pack-sdk's empty run (R-00588 batch) was
 * exactly that. Every eng/*.mjs CLI guard compares through this helper.
 */
export function isCliEntry(importMetaUrl) {
  if (!process.argv[1]) return false;
  const real = (path) => { try { return realpathSync(path); } catch { return null; } };
  let selfPath;
  try {
    selfPath = fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }
  const invoked = real(process.argv[1]);
  const self = real(selfPath);
  return invoked !== null && self !== null && invoked === self;
}
