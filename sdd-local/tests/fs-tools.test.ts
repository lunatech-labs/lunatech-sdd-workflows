import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeTempRepo, TempRepo } from './helpers/temp-repo';
import { resolveInRepo, SandboxError } from '../src/tools/sandbox';
import {
  readFile,
  writeFile,
  listFiles,
  searchFiles,
  READ_SIZE_CAP_BYTES,
  MAX_SEARCH_MATCHES,
} from '../src/tools/fs-tools';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('sandbox: resolveInRepo', () => {
  let repo: TempRepo;
  let outside: string;

  beforeEach(async () => {
    repo = await makeTempRepo({
      files: { 'src/app.ts': 'export const x = 1;\n' },
    });
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-outside-')));
  });

  afterEach(async () => {
    await repo.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  });

  test('resolves a relative path inside the repo', async () => {
    const resolved = await resolveInRepo(repo.root, 'src/app.ts');
    expect(resolved).toBe(path.join(repo.root, 'src', 'app.ts'));
  });

  test('resolves "." to the repo root itself', async () => {
    expect(await resolveInRepo(repo.root, '.')).toBe(repo.root);
  });

  test('resolves a not-yet-existing path inside the repo (for writes)', async () => {
    const resolved = await resolveInRepo(repo.root, 'new/dir/file.txt');
    expect(resolved).toBe(path.join(repo.root, 'new', 'dir', 'file.txt'));
  });

  test('rejects relative ../ escapes', async () => {
    await expect(resolveInRepo(repo.root, '../escape.txt')).rejects.toThrow(SandboxError);
    await expect(resolveInRepo(repo.root, 'src/../../escape.txt')).rejects.toThrow(SandboxError);
  });

  test('rejects absolute paths outside the repo', async () => {
    await expect(resolveInRepo(repo.root, path.join(outside, 'evil.txt'))).rejects.toThrow(
      SandboxError,
    );
    await expect(resolveInRepo(repo.root, '/etc/passwd')).rejects.toThrow(SandboxError);
  });

  test('accepts an absolute path inside the repo', async () => {
    const inside = path.join(repo.root, 'src', 'app.ts');
    expect(await resolveInRepo(repo.root, inside)).toBe(inside);
  });

  test('rejects symlink escapes through an existing link', async () => {
    await fs.symlink(outside, path.join(repo.root, 'link'));
    // The final file does not exist; the escape is in the existing ancestor.
    await expect(resolveInRepo(repo.root, 'link/evil.txt')).rejects.toThrow(SandboxError);
    // A link directly to an outside file is rejected too.
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(repo.root, 'file-link'));
    await expect(resolveInRepo(repo.root, 'file-link')).rejects.toThrow(SandboxError);
  });

  test('allows symlinks that stay inside the repo', async () => {
    await fs.symlink(path.join(repo.root, 'src'), path.join(repo.root, 'src-link'));
    const resolved = await resolveInRepo(repo.root, 'src-link/app.ts');
    expect(resolved).toBe(path.join(repo.root, 'src', 'app.ts'));
  });

  test('rejects when the repo root does not exist', async () => {
    await expect(resolveInRepo(path.join(outside, 'no-such-root'), 'a.txt')).rejects.toThrow(
      SandboxError,
    );
  });
});

describe('fs-tools: readFile', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await makeTempRepo({
      files: { 'notes.md': 'hello world\n' },
    });
  });

  afterEach(() => repo.cleanup());

  test('reads a file inside the repo', async () => {
    const result = await readFile(repo.root, { path: 'notes.md' });
    expect(result).toEqual({ ok: true, output: 'hello world\n' });
  });

  test('returns an error for a missing file', async () => {
    const result = await readFile(repo.root, { path: 'nope.md' });
    expect(result.ok).toBe(false);
  });

  test('returns an error for a directory', async () => {
    await repo.writeFile('dir/x.txt', 'x');
    const result = await readFile(repo.root, { path: 'dir' });
    expect(result.ok).toBe(false);
  });

  test('truncates files over the size cap', async () => {
    await repo.writeFile('big.txt', 'a'.repeat(READ_SIZE_CAP_BYTES + 100));
    const result = await readFile(repo.root, { path: 'big.txt' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('[truncated:');
      expect(result.output.length).toBeLessThan(READ_SIZE_CAP_BYTES + 100);
    }
  });

  test('rejects ../ escapes as a tool error, not a throw', async () => {
    const result = await readFile(repo.root, { path: '../../etc/hosts' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('outside the repo root');
  });
});

describe('fs-tools: writeFile (AC7: nothing outside the repo is touched)', () => {
  let repo: TempRepo;
  let outside: string;

  beforeEach(async () => {
    repo = await makeTempRepo();
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-outside-')));
  });

  afterEach(async () => {
    await repo.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  });

  test('writes a file, creating parent directories', async () => {
    const result = await writeFile(repo.root, { path: 'a/b/c.txt', content: 'deep' });
    expect(result.ok).toBe(true);
    expect(await repo.readFile('a/b/c.txt')).toBe('deep');
  });

  test('overwrites an existing file', async () => {
    await repo.writeFile('f.txt', 'old');
    const result = await writeFile(repo.root, { path: 'f.txt', content: 'new' });
    expect(result.ok).toBe(true);
    expect(await repo.readFile('f.txt')).toBe('new');
  });

  test('../ escape is rejected and no file is created outside the repo', async () => {
    const result = await writeFile(repo.root, { path: '../escaped.txt', content: 'evil' });
    expect(result.ok).toBe(false);
    expect(await exists(path.resolve(repo.root, '..', 'escaped.txt'))).toBe(false);
  });

  test('absolute-path escape is rejected and no file is created outside the repo', async () => {
    const target = path.join(outside, 'escaped.txt');
    const result = await writeFile(repo.root, { path: target, content: 'evil' });
    expect(result.ok).toBe(false);
    expect(await exists(target)).toBe(false);
  });

  test('symlink escape is rejected and no file is created outside the repo', async () => {
    await fs.symlink(outside, path.join(repo.root, 'link'));
    const result = await writeFile(repo.root, { path: 'link/escaped.txt', content: 'evil' });
    expect(result.ok).toBe(false);
    expect(await exists(path.join(outside, 'escaped.txt'))).toBe(false);
    // The outside directory is byte-for-byte untouched: still empty.
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

describe('fs-tools: listFiles', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await makeTempRepo({
      git: true,
      files: {
        'README.md': '# readme\n',
        'src/index.ts': '1\n',
        'src/tools/deep.ts': '2\n',
        'docs/guide.md': '3\n',
      },
    });
  });

  afterEach(() => repo.cleanup());

  test('lists every file by default, skipping .git', async () => {
    const result = await listFiles(repo.root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = result.output.split('\n');
      expect(lines).toEqual(['README.md', 'docs/guide.md', 'src/index.ts', 'src/tools/deep.ts']);
      expect(result.output).not.toContain('.git');
    }
  });

  test('** glob matches at any depth', async () => {
    const result = await listFiles(repo.root, { pattern: '**/*.ts' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.split('\n')).toEqual(['src/index.ts', 'src/tools/deep.ts']);
    }
  });

  test('* glob is segment-scoped', async () => {
    const result = await listFiles(repo.root, { pattern: 'src/*.ts' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.split('\n')).toEqual(['src/index.ts']);
    }
  });

  test('no matches yields an ok result', async () => {
    const result = await listFiles(repo.root, { pattern: '**/*.py' });
    expect(result).toEqual({ ok: true, output: '(no matches)' });
  });
});

describe('fs-tools: searchFiles', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await makeTempRepo({
      files: {
        'src/a.ts': 'const alpha = 1;\nconst beta = 2;\n',
        'src/b.ts': 'function alphaFn() {}\n',
        'docs/c.md': 'alpha appears here too\n',
      },
    });
  });

  afterEach(() => repo.cleanup());

  test('finds regex matches with path and line number', async () => {
    const result = await searchFiles(repo.root, { pattern: 'alpha' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = result.output.split('\n');
      expect(lines).toContain('src/a.ts:1: const alpha = 1;');
      expect(lines).toContain('src/b.ts:1: function alphaFn() {}');
      expect(lines).toContain('docs/c.md:1: alpha appears here too');
    }
  });

  test('glob filter narrows the searched files', async () => {
    const result = await searchFiles(repo.root, { pattern: 'alpha', glob: '**/*.ts' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).not.toContain('docs/c.md');
      expect(result.output).toContain('src/a.ts:1:');
    }
  });

  test('caps the number of matches', async () => {
    const many = Array.from({ length: MAX_SEARCH_MATCHES + 50 }, (_, i) => `match ${i}`).join('\n');
    await repo.writeFile('many.txt', many + '\n');
    const result = await searchFiles(repo.root, { pattern: 'match' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = result.output.split('\n');
      // MAX_SEARCH_MATCHES match lines plus the truncation note.
      expect(lines.length).toBe(MAX_SEARCH_MATCHES + 1);
      expect(lines[lines.length - 1]).toContain('[truncated at');
    }
  });

  test('invalid regex returns a tool error', async () => {
    const result = await searchFiles(repo.root, { pattern: '([unclosed' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid regex');
  });

  test('no matches yields an ok result', async () => {
    const result = await searchFiles(repo.root, { pattern: 'zzz-not-here' });
    expect(result).toEqual({ ok: true, output: '(no matches)' });
  });
});
