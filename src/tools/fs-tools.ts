/**
 * Sandboxed file tools for the agent tool registry: read, write, list, search.
 *
 * Every path argument goes through resolveInRepo, so nothing outside the
 * target repo root is ever touched (AC7). Tools never throw on bad input;
 * they return { ok: false, error } so the agent loop can hand the failure
 * back to the model as a tool error.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { resolveInRepo, SandboxError } from './sandbox';

/** Result shape every tool returns to the registry. */
export type ToolResult = { ok: true; output: string } | { ok: false; error: string };

/** Max bytes returned by readFile before truncation. */
export const READ_SIZE_CAP_BYTES = 262144; // 256 KiB

/** Max entries returned by listFiles. */
export const MAX_LIST_ENTRIES = 500;

/** Max matching lines returned by searchFiles. */
export const MAX_SEARCH_MATCHES = 100;

/** Files larger than this are skipped by searchFiles. */
const SEARCH_FILE_SIZE_CAP_BYTES = 1048576; // 1 MiB

/** Directory names never walked by listFiles / searchFiles. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function errorResult(err: unknown): ToolResult {
  if (err instanceof SandboxError) {
    return { ok: false, error: err.message };
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** Read a repo-relative file, truncated at READ_SIZE_CAP_BYTES. */
export async function readFile(repoRoot: string, args: { path: string }): Promise<ToolResult> {
  try {
    const target = await resolveInRepo(repoRoot, args.path);
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      return { ok: false, error: `not a file: ${args.path}` };
    }
    const buffer = await fs.readFile(target);
    if (buffer.byteLength <= READ_SIZE_CAP_BYTES) {
      return { ok: true, output: buffer.toString('utf8') };
    }
    const truncated = buffer.subarray(0, READ_SIZE_CAP_BYTES).toString('utf8');
    return {
      ok: true,
      output:
        truncated +
        `\n[truncated: file is ${buffer.byteLength} bytes, showing first ${READ_SIZE_CAP_BYTES}]`,
    };
  } catch (err) {
    return errorResult(err);
  }
}

/** Write a repo-relative file, creating parent directories as needed. */
export async function writeFile(
  repoRoot: string,
  args: { path: string; content: string },
): Promise<ToolResult> {
  try {
    const target = await resolveInRepo(repoRoot, args.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, args.content, 'utf8');
    return { ok: true, output: `wrote ${Buffer.byteLength(args.content, 'utf8')} bytes to ${args.path}` };
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * Convert a glob pattern to a RegExp over repo-relative POSIX-style paths.
 * Supports "**" (any depth), "*" (within a segment), and "?".
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Walk the repo collecting repo-relative file paths (POSIX separators),
 * skipping SKIP_DIRS and never following symlinks, so the walk itself
 * cannot leave the repo.
 */
async function walkFiles(realRoot: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [''];
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    const dir = rel === '' ? realRoot : path.join(realRoot, rel);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          queue.push(entryRel);
        }
      } else if (entry.isFile()) {
        out.push(entryRel);
      }
      // Symlinks are neither listed nor followed.
    }
  }
  return out.sort();
}

/**
 * List repo files matching a glob pattern (default: every file), capped at
 * MAX_LIST_ENTRIES.
 */
export async function listFiles(
  repoRoot: string,
  args: { pattern?: string } = {},
): Promise<ToolResult> {
  try {
    const realRoot = await resolveInRepo(repoRoot, '.');
    let matcher: RegExp;
    try {
      matcher = globToRegExp(args.pattern ?? '**');
    } catch (err) {
      return { ok: false, error: `invalid glob pattern: ${args.pattern}` };
    }
    const all = await walkFiles(realRoot);
    const matched = all.filter((p) => matcher.test(p));
    if (matched.length === 0) {
      return { ok: true, output: '(no matches)' };
    }
    const shown = matched.slice(0, MAX_LIST_ENTRIES);
    let output = shown.join('\n');
    if (matched.length > shown.length) {
      output += `\n[truncated: ${matched.length} matches, showing first ${shown.length}]`;
    }
    return { ok: true, output };
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * Search repo files line by line with a regex, optionally filtered by a
 * glob, capped at MAX_SEARCH_MATCHES matching lines. Output lines are
 * "path:lineNumber: text". Binary files (NUL byte) and files over the size
 * cap are skipped.
 */
export async function searchFiles(
  repoRoot: string,
  args: { pattern: string; glob?: string },
): Promise<ToolResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern);
  } catch (err) {
    return { ok: false, error: `invalid regex: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const realRoot = await resolveInRepo(repoRoot, '.');
    const matcher = args.glob ? globToRegExp(args.glob) : undefined;
    const matches: string[] = [];
    let capped = false;
    for (const rel of await walkFiles(realRoot)) {
      if (matcher && !matcher.test(rel)) continue;
      const full = path.join(realRoot, rel);
      let buffer: Buffer;
      try {
        const stat = await fs.stat(full);
        if (stat.size > SEARCH_FILE_SIZE_CAP_BYTES) continue;
        buffer = await fs.readFile(full);
      } catch {
        continue;
      }
      if (buffer.includes(0)) continue; // binary
      const lines = buffer.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i]}`);
          if (matches.length >= MAX_SEARCH_MATCHES) {
            capped = true;
            break;
          }
        }
      }
      if (capped) break;
    }
    if (matches.length === 0) {
      return { ok: true, output: '(no matches)' };
    }
    let output = matches.join('\n');
    if (capped) {
      output += `\n[truncated at ${MAX_SEARCH_MATCHES} matches]`;
    }
    return { ok: true, output };
  } catch (err) {
    return errorResult(err);
  }
}
