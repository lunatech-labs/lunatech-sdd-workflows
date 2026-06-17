/**
 * Repo-root path confinement for file tools (AC7).
 *
 * resolveInRepo(repoRoot, p) resolves a tool-supplied path and throws a
 * SandboxError when it escapes the repo root via:
 *   - relative traversal ("../outside")
 *   - an absolute path outside the root
 *   - a symlink inside the repo pointing outside (caught by realpathing the
 *     nearest existing ancestor before the prefix check, since a plain
 *     path.resolve prefix check is bypassable through symlinks)
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Thrown when a path resolves outside the repo root. */
export class SandboxError extends Error {
  /** The path the caller asked for, before resolution. */
  readonly attemptedPath: string;

  constructor(message: string, attemptedPath: string) {
    super(message);
    this.name = 'SandboxError';
    this.attemptedPath = attemptedPath;
  }
}

/**
 * Realpath the nearest existing ancestor of `p`, then re-append the
 * not-yet-existing remainder. This resolves symlinks in every existing
 * component, so a link escaping the repo is exposed even when the final
 * target (e.g. a file about to be written) does not exist yet.
 */
async function realpathNearestAncestor(p: string): Promise<string> {
  let current = p;
  const remainder: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return remainder.length === 0 ? real : path.join(real, ...remainder);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Hit the filesystem root without finding anything that exists;
        // nothing left to resolve.
        return p;
      }
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

function assertInside(realRoot: string, candidate: string, attemptedPath: string): void {
  if (candidate !== realRoot && !candidate.startsWith(realRoot + path.sep)) {
    throw new SandboxError(
      `path resolves outside the repo root (${realRoot}): ${attemptedPath}`,
      attemptedPath,
    );
  }
}

/**
 * Resolve `p` (relative to `repoRoot`, or absolute) and return the resolved
 * absolute path, guaranteed to lie inside the repo root. Throws SandboxError
 * on any escape, including symlink escapes.
 */
export async function resolveInRepo(repoRoot: string, p: string): Promise<string> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(repoRoot);
  } catch {
    throw new SandboxError(`repo root does not exist: ${repoRoot}`, p);
  }

  // Lexical check first: catches plain ../ traversal and absolute paths
  // outside the root without touching the filesystem.
  const candidate = path.resolve(realRoot, p);
  assertInside(realRoot, candidate, p);

  // Symlink check: realpath the nearest existing ancestor so links inside
  // the repo that point outside are caught before any read or write.
  const real = await realpathNearestAncestor(candidate);
  assertInside(realRoot, real, p);

  return real;
}
