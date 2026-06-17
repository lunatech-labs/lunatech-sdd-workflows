import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { startMockOllama, MockOllamaServer } from './helpers/mock-ollama';
import { makeTempRepo, TempRepo } from './helpers/temp-repo';
import {
  CONFIG_FILE_NAME,
  ConfigError,
  ROLES,
  SddConfig,
  loadConfigFile,
  resolveConfig,
} from '../src/config';
import type { UI } from '../src/ui';

const MODELS = ['model-a', 'model-b', 'model-c'];

/** A UI whose answers come from queues; any unscripted call throws, so a
 * test fails loudly when config code prompts where it should not. */
interface ScriptedUI extends UI {
  calls: {
    asks: string[];
    confirms: string[];
    selects: Array<{ label: string; options: string[] }>;
  };
}

function scriptedUI(script: {
  asks?: string[];
  confirms?: boolean[];
  selects?: string[];
} = {}): ScriptedUI {
  const asks = [...(script.asks ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const selects = [...(script.selects ?? [])];
  const calls: ScriptedUI['calls'] = { asks: [], confirms: [], selects: [] };
  return {
    calls,
    async ask(question) {
      calls.asks.push(question);
      const next = asks.shift();
      if (next === undefined) throw new Error(`unscripted ask: ${question}`);
      return next;
    },
    async confirm(question) {
      calls.confirms.push(question);
      const next = confirms.shift();
      if (next === undefined) throw new Error(`unscripted confirm: ${question}`);
      return next;
    },
    async select(label, options) {
      calls.selects.push({ label, options });
      const next = selects.shift();
      if (next === undefined) throw new Error(`unscripted select: ${label}`);
      return next;
    },
    async readAnswer(message) {
      throw new Error(`unscripted readAnswer: ${message}`);
    },
  };
}

function fullConfig(baseUrl: string, model = 'model-a'): SddConfig {
  return {
    ollamaBaseUrl: baseUrl,
    models: {
      supervisor: model,
      planner: model,
      implementer: model,
      critic: model,
    },
  };
}

async function writeConfig(repo: TempRepo, config: unknown): Promise<void> {
  await repo.writeFile(CONFIG_FILE_NAME, JSON.stringify(config, null, 2));
}

describe('config (AC8, AC9)', () => {
  let mock: MockOllamaServer;
  let repo: TempRepo;

  beforeAll(async () => {
    mock = await startMockOllama({ models: MODELS });
  });

  afterAll(() => mock.close());

  beforeEach(async () => {
    mock.reset();
    mock.setModels(MODELS);
    await repo?.cleanup();
    repo = await makeTempRepo();
  });

  afterAll(() => repo?.cleanup());

  describe('loadConfigFile', () => {
    test('returns an empty partial config when the file is missing', async () => {
      expect(await loadConfigFile(repo.root)).toEqual({ models: {} });
    });

    test('rejects invalid JSON with a message naming the file', async () => {
      await repo.writeFile(CONFIG_FILE_NAME, '{not json');
      const err = await loadConfigFile(repo.root).catch(e => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain(CONFIG_FILE_NAME);
      expect(err.message).toContain('not valid JSON');
    });

    test('rejects a non-string base URL', async () => {
      await writeConfig(repo, { ollamaBaseUrl: 42 });
      const err = await loadConfigFile(repo.root).catch(e => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain('ollamaBaseUrl');
    });

    test('rejects an unknown role in models, naming the valid roles', async () => {
      await writeConfig(repo, { models: { implementor: 'model-a' } });
      const err = await loadConfigFile(repo.root).catch(e => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain('implementor');
      expect(err.message).toContain('supervisor, planner, implementer, critic');
    });

    test('rejects a non-string role model', async () => {
      await writeConfig(repo, { models: { critic: null } });
      const err = await loadConfigFile(repo.root).catch(e => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain('models.critic');
    });
  });

  describe('resolveConfig with a complete config', () => {
    test('honors the configured models without prompting and never writes back', async () => {
      const configured: SddConfig = {
        ollamaBaseUrl: mock.baseUrl,
        models: {
          supervisor: 'model-a',
          planner: 'model-b',
          implementer: 'model-c',
          critic: 'model-a',
        },
      };
      await writeConfig(repo, configured);
      const ui = scriptedUI(); // every prompt would throw
      const warnings: string[] = [];

      const resolved = await resolveConfig({
        repoRoot: repo.root,
        ui,
        warn: m => warnings.push(m),
      });

      expect(resolved).toEqual(configured);
      expect(ui.calls.asks).toEqual([]);
      expect(ui.calls.selects).toEqual([]);
      expect(ui.calls.confirms).toEqual([]); // no write-back offer
      expect(warnings).toEqual([]); // mock advertises tools by default
      // The file on disk is untouched.
      expect(JSON.parse(await repo.readFile(CONFIG_FILE_NAME))).toEqual(configured);
    });
  });

  describe('resolveConfig with missing entries', () => {
    test('selects a missing role model from the /api/tags list', async () => {
      await writeConfig(repo, {
        ollamaBaseUrl: mock.baseUrl,
        models: {
          supervisor: 'model-a',
          planner: 'model-a',
          implementer: 'model-a',
        },
      });
      const ui = scriptedUI({ selects: ['model-b'], confirms: [false] });

      const resolved = await resolveConfig({ repoRoot: repo.root, ui, warn: () => {} });

      expect(resolved.models.critic).toBe('model-b');
      expect(ui.calls.selects).toHaveLength(1);
      expect(ui.calls.selects[0].label).toContain('critic');
      expect(ui.calls.selects[0].options).toEqual(MODELS);
    });

    test('asks for a missing base URL before pinging', async () => {
      await writeConfig(repo, { models: fullConfig(mock.baseUrl).models });
      const ui = scriptedUI({ asks: [mock.baseUrl], confirms: [false] });

      const resolved = await resolveConfig({ repoRoot: repo.root, ui, warn: () => {} });

      expect(resolved.ollamaBaseUrl).toBe(mock.baseUrl);
      expect(ui.calls.asks).toHaveLength(1);
    });

    test('with no config file at all, fills everything and writes back on confirm', async () => {
      const ui = scriptedUI({
        asks: [mock.baseUrl],
        selects: ['model-a', 'model-b', 'model-c', 'model-a'],
        confirms: [true],
      });

      const resolved = await resolveConfig({ repoRoot: repo.root, ui, warn: () => {} });

      expect(resolved).toEqual({
        ollamaBaseUrl: mock.baseUrl,
        models: {
          supervisor: 'model-a',
          planner: 'model-b',
          implementer: 'model-c',
          critic: 'model-a',
        },
      });
      // Role selection happens in the declared role order.
      expect(ui.calls.selects.map(s => s.label)).toEqual(
        ROLES.map(role => expect.stringContaining(role)),
      );
      // Written back only after explicit confirmation, matching the result.
      const onDisk = JSON.parse(await repo.readFile(CONFIG_FILE_NAME));
      expect(onDisk).toEqual(resolved);
    });

    test('does not write back when the user declines', async () => {
      const ui = scriptedUI({
        asks: [mock.baseUrl],
        selects: ['model-a', 'model-a', 'model-a', 'model-a'],
        confirms: [false],
      });

      await resolveConfig({ repoRoot: repo.root, ui, warn: () => {} });

      await expect(
        fs.access(path.join(repo.root, CONFIG_FILE_NAME)),
      ).rejects.toThrow();
    });

    test('fails clearly when Ollama has no installed models', async () => {
      mock.setModels([]);
      await writeConfig(repo, { ollamaBaseUrl: mock.baseUrl });
      const ui = scriptedUI();

      const err = await resolveConfig({ repoRoot: repo.root, ui, warn: () => {} }).catch(
        e => e,
      );

      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain('ollama pull');
      expect(ui.calls.selects).toEqual([]);
    });
  });

  describe('resolveConfig when Ollama is unreachable (AC9)', () => {
    test('fails with an actionable error before any model selection', async () => {
      const closedUrl = await closedPortUrl();
      await writeConfig(repo, { ollamaBaseUrl: closedUrl });
      const ui = scriptedUI(); // selection would throw "unscripted select"

      const err = await resolveConfig({ repoRoot: repo.root, ui, warn: () => {} }).catch(
        e => e,
      );

      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain(closedUrl);
      expect(err.message).toContain('ollama serve');
      expect(ui.calls.selects).toEqual([]);
      expect(ui.calls.confirms).toEqual([]);
    });
  });

  describe('capability warnings', () => {
    test('warns when a model does not advertise tools, once per distinct model', async () => {
      mock.setCapabilities(['completion'], 'model-b');
      await writeConfig(repo, {
        ollamaBaseUrl: mock.baseUrl,
        models: {
          supervisor: 'model-a',
          planner: 'model-b',
          implementer: 'model-b',
          critic: 'model-a',
        },
      });
      const warnings: string[] = [];

      await resolveConfig({ repoRoot: repo.root, ui: scriptedUI(), warn: m => warnings.push(m) });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('model-b');
      expect(warnings[0]).toContain('does not advertise tool-calling support');
    });

    test('warns "could not verify" when the server reports no capabilities field', async () => {
      const server = await startInlineServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/api/tags') {
          res.end(JSON.stringify({ models: [{ name: 'old-model' }] }));
        } else {
          // /api/show without a capabilities field, like older Ollama versions.
          res.end(JSON.stringify({ license: 'MIT' }));
        }
      });
      try {
        await writeConfig(repo, fullConfig(server.url, 'old-model'));
        const warnings: string[] = [];

        await resolveConfig({
          repoRoot: repo.root,
          ui: scriptedUI(),
          warn: m => warnings.push(m),
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Could not verify');
        expect(warnings[0]).toContain('old-model');
        expect(warnings[0]).not.toContain('does not advertise');
      } finally {
        await server.close();
      }
    });

    test('warns "could not verify" when /api/show itself fails', async () => {
      const server = await startInlineServer((req, res) => {
        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [{ name: 'some-model' }] }));
        } else {
          res.writeHead(500);
          res.end('boom');
        }
      });
      try {
        await writeConfig(repo, fullConfig(server.url, 'some-model'));
        const warnings: string[] = [];

        await resolveConfig({
          repoRoot: repo.root,
          ui: scriptedUI(),
          warn: m => warnings.push(m),
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Could not verify');
      } finally {
        await server.close();
      }
    });
  });
});

describe('no hardcoded model names (AC8)', () => {
  // Known locally installed model names that must never appear in source
  // code or prompts. Case-insensitive substring match.
  const FORBIDDEN = ['devstral', 'gpt-oss', 'llama3', 'glm-4'];
  const packageRoot = path.resolve(__dirname, '..');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(full));
      } else {
        out.push(full);
      }
    }
    return out;
  }

  const files = [
    ...walk(path.join(packageRoot, 'src')),
    ...walk(path.join(packageRoot, 'prompts')),
  ];

  test('src/ and prompts/ contain files to scan', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test.each(files.map(f => [path.relative(packageRoot, f), f]))(
    '%s mentions no known local model name',
    (_rel, file) => {
      const content = readFileSync(file, 'utf8').toLowerCase();
      for (const name of FORBIDDEN) {
        expect(content, `"${name}" found in ${file}`).not.toContain(name);
      }
    },
  );
});

/** Start a mock server, close it, and return its now-unreachable base URL. */
async function closedPortUrl(): Promise<string> {
  const sacrifice = await startMockOllama();
  const url = sacrifice.baseUrl;
  await sacrifice.close();
  return url;
}

interface InlineServer {
  url: string;
  close: () => Promise<void>;
}

/** Tiny throwaway HTTP server for response shapes the mock cannot produce. */
async function startInlineServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<InlineServer> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
