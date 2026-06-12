/**
 * Throwaway target-repo fixtures for tests.
 *
 * Wraps fs.mkdtemp with optional git init, optional seeded files (nested
 * paths allowed), an optional initial commit, and cleanup.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TempRepoOptions {
  /** Run `git init` in the new directory. Default false. */
  git?: boolean;
  /** Files to seed, as repo-relative path -> content. Parent directories are
   * created as needed. */
  files?: Record<string, string>;
  /** Commit the seeded files after git init, giving the repo history and a
   * clean working tree. Requires git: true. Default false. */
  commit?: boolean;
  /** Temp directory name prefix. Default "sdd-test-". */
  prefix?: string;
}

export interface TempRepo {
  /** Absolute path to the repo root (realpath-resolved). */
  root: string;
  /** Run a git command in the repo, returning stdout. */
  git(...args: string[]): Promise<string>;
  /** Write (or overwrite) a repo-relative file, creating parents. */
  writeFile(relativePath: string, content: string): Promise<void>;
  /** Read a repo-relative file as utf8. */
  readFile(relativePath: string): Promise<string>;
  /** Remove the whole temp directory. */
  cleanup(): Promise<void>;
}

export async function makeTempRepo(options: TempRepoOptions = {}): Promise<TempRepo> {
  const prefix = options.prefix ?? 'sdd-test-';
  const created = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  // macOS tmpdirs live behind a /var -> /private/var symlink; resolve once so
  // sandbox prefix checks in tests compare like with like.
  const root = await fs.realpath(created);

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd: root });
    return stdout;
  };

  const writeFile = async (relativePath: string, content: string): Promise<void> => {
    const target = path.join(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  };

  const readFile = (relativePath: string): Promise<string> =>
    fs.readFile(path.join(root, relativePath), 'utf8');

  if (options.git) {
    await git('init', '--quiet');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
  }

  if (options.files) {
    for (const [relativePath, content] of Object.entries(options.files)) {
      await writeFile(relativePath, content);
    }
  }

  if (options.commit) {
    if (!options.git) {
      throw new Error('makeTempRepo: commit: true requires git: true');
    }
    await git('add', '-A');
    await git('commit', '--quiet', '--allow-empty', '-m', 'seed');
  }

  return {
    root,
    git,
    writeFile,
    readFile,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
