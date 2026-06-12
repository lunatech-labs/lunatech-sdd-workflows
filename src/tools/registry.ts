/**
 * Tool registry: JSON-schema definitions for the six agent tools, per-role
 * subsets, and dispatch of model tool calls to the T5/T6 implementations.
 *
 * Tools: read_file, write_file, list_files, search_files, run_command, and
 * report (the finish call that ends a dispatch). Subsets mirror upstream:
 * the critic gets no write_file (it verifies, never fixes) and the
 * supervisor gets no run_command (the interview needs no shell).
 *
 * The report schema is role-specific, matching what the vendored prompts
 * tell each agent to report: the supervisor reports the spec path, the
 * planner a Gate 2 summary, the implementer a CLEAN/DRIFT status, and the
 * critic a PASS/FAIL/DRIFT verdict.
 *
 * execute() never throws: failures come back as { ok: false, error } so the
 * agent loop can hand them to the model as tool errors. Results carry
 * `malformed: true` when the call itself was bad (unknown tool, invalid
 * argument shape), so the loop can count them toward its malformed-call cap.
 */
import type { ToolDefinition } from '../ollama';
import type { UI } from '../ui';
import { readFile, writeFile, listFiles, searchFiles, ToolResult } from './fs-tools';
import { runCommand } from './run-command';

/** The four agent roles the orchestrator dispatches. */
export type AgentRole = 'supervisor' | 'planner' | 'implementer' | 'critic';

/** Name of the finish tool that ends an agent dispatch. */
export const REPORT_TOOL_NAME = 'report';

/**
 * Result of one tool execution. `malformed: true` marks failures caused by
 * the call itself (unknown tool, invalid arguments) that count toward the
 * agent loop's malformed-call cap; ordinary tool failures (file not found,
 * command denied by the user) do not carry the flag.
 */
export type ToolExecutionResult = ToolResult & { malformed?: boolean };

export type ValidationResult = { ok: true } | { ok: false; error: string };

export interface ToolRegistry {
  readonly role: AgentRole;
  /** Tool definitions for this role, to pass to /api/chat. */
  readonly definitions: ToolDefinition[];
  /** Validate report-call arguments against this role's report schema. */
  validateReport(args: Record<string, unknown>): ValidationResult;
  /** Execute one non-report tool call. Never throws. */
  execute(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
}

/** All tool parameters are strings, which keeps validation trivial. */
type SchemaProperty = {
  type: 'string';
  description: string;
  enum?: string[];
};

type ParametersSchema = {
  type: 'object';
  properties: Record<string, SchemaProperty>;
  required: string[];
};

function tool(
  name: string,
  description: string,
  properties: Record<string, SchemaProperty>,
  required: string[],
): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required } satisfies ParametersSchema,
    },
  };
}

const READ_FILE = tool(
  'read_file',
  'Read one file from the target repo.',
  { path: { type: 'string', description: 'Repo-relative path of the file to read' } },
  ['path'],
);

const WRITE_FILE = tool(
  'write_file',
  'Create or overwrite one file in the target repo with the complete file content.',
  {
    path: { type: 'string', description: 'Repo-relative path of the file to write' },
    content: { type: 'string', description: 'The complete new content of the file' },
  },
  ['path', 'content'],
);

const LIST_FILES = tool(
  'list_files',
  'List files in the target repo matching a glob pattern (omit the pattern to list every file).',
  {
    pattern: {
      type: 'string',
      description: 'Glob pattern over repo-relative paths, e.g. "specs/**" or "src/*.ts"',
    },
  },
  [],
);

const SEARCH_FILES = tool(
  'search_files',
  'Search file contents in the target repo with a regular expression.',
  {
    pattern: { type: 'string', description: 'Regular expression to search for, line by line' },
    glob: { type: 'string', description: 'Optional glob pattern restricting which files are searched' },
  },
  ['pattern'],
);

const RUN_COMMAND = tool(
  'run_command',
  'Run one shell command in the repo root. The command is shown to the user and only runs if they confirm it; a denial comes back as a "denied by user" error.',
  { command: { type: 'string', description: 'The exact shell command to run' } },
  ['command'],
);

/**
 * Role-specific report schemas, aligned with what each vendored prompt in
 * prompts/ tells the agent to report.
 */
const REPORT_BY_ROLE: Record<AgentRole, ToolDefinition> = {
  supervisor: tool(
    REPORT_TOOL_NAME,
    'End the interview. Call exactly once, only after spec.md has been saved with write_file.',
    {
      spec_path: {
        type: 'string',
        description: 'Repo-relative path of the saved spec, e.g. "specs/001-feature-slug/spec.md"',
      },
    },
    ['spec_path'],
  ),
  planner: tool(
    REPORT_TOOL_NAME,
    'End your dispatch with your final report. Call exactly once, when plan.md and spec section 6 are written.',
    {
      summary: { type: 'string', description: 'Technical approach summary' },
      task_list: { type: 'string', description: 'The task breakdown written to spec section 6' },
      open_questions: { type: 'string', description: 'Open questions raised, if any' },
      gate_notes: { type: 'string', description: 'Anything the user should see at Gate 2' },
    },
    ['summary'],
  ),
  implementer: tool(
    REPORT_TOOL_NAME,
    'End your dispatch with your final report. Call exactly once, when you are done.',
    {
      task_id: { type: 'string', description: 'The task ID you implemented, e.g. "T2"' },
      changes: { type: 'string', description: 'Files you changed, one line each' },
      verification: { type: 'string', description: 'The verification you ran and its results' },
      status: {
        type: 'string',
        description: 'CLEAN, or DRIFT when the spec or plan is wrong or incomplete',
        enum: ['CLEAN', 'DRIFT'],
      },
      details: { type: 'string', description: 'DRIFT specifics, when status is DRIFT' },
    },
    ['task_id', 'changes', 'verification', 'status'],
  ),
  critic: tool(
    REPORT_TOOL_NAME,
    'End your dispatch with your verdict. Call exactly once, when you are done.',
    {
      verdict: {
        type: 'string',
        description: 'PASS, FAIL, or DRIFT when the spec or plan itself is wrong',
        enum: ['PASS', 'FAIL', 'DRIFT'],
      },
      details: {
        type: 'string',
        description:
          'What you verified and how (PASS); each failure with the AC or rule it violates and what must change (FAIL); the spec/plan mismatch (DRIFT)',
      },
    },
    ['verdict', 'details'],
  ),
};

/** Check args against a parameters schema: required keys, types, enums. */
function validateArgs(schema: ParametersSchema, args: Record<string, unknown>): ValidationResult {
  for (const key of schema.required) {
    if (args[key] === undefined) {
      return { ok: false, error: `missing required argument "${key}"` };
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (property === undefined) {
      continue; // Tolerate extra arguments; models add them.
    }
    if (typeof value !== property.type) {
      return { ok: false, error: `argument "${key}" must be a ${property.type}` };
    }
    if (property.enum !== undefined && !property.enum.includes(value as string)) {
      return {
        ok: false,
        error: `argument "${key}" must be one of: ${property.enum.join(', ')}`,
      };
    }
  }
  return { ok: true };
}

export interface ToolRegistryOptions {
  /** Target repo root that file tools and run_command are confined to. */
  repoRoot: string;
  role: AgentRole;
  /** Injected UI; used for the per-command run_command confirmation. */
  ui: UI;
}

/** Build the tool registry for one role: definitions plus dispatch. */
export function createToolRegistry({ repoRoot, role, ui }: ToolRegistryOptions): ToolRegistry {
  const definitions: ToolDefinition[] = [
    READ_FILE,
    ...(role === 'critic' ? [] : [WRITE_FILE]),
    LIST_FILES,
    SEARCH_FILES,
    ...(role === 'supervisor' ? [] : [RUN_COMMAND]),
    REPORT_BY_ROLE[role],
  ];

  const schemaOf = (name: string): ParametersSchema | undefined => {
    const definition = definitions.find(d => d.function.name === name);
    return definition === undefined
      ? undefined
      : (definition.function.parameters as ParametersSchema);
  };

  const validateReport = (args: Record<string, unknown>): ValidationResult =>
    validateArgs(REPORT_BY_ROLE[role].function.parameters as ParametersSchema, args);

  const execute = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> => {
    if (name === REPORT_TOOL_NAME) {
      return {
        ok: false,
        error: 'the report tool ends the dispatch and is handled by the agent loop, not executed',
      };
    }
    const schema = schemaOf(name);
    if (schema === undefined) {
      const available = definitions.map(d => d.function.name).join(', ');
      return {
        ok: false,
        error: `unknown tool "${name}". Available tools: ${available}`,
        malformed: true,
      };
    }
    const valid = validateArgs(schema, args);
    if (!valid.ok) {
      return {
        ok: false,
        error: `invalid arguments for ${name}: ${valid.error}`,
        malformed: true,
      };
    }
    switch (name) {
      case 'read_file':
        return readFile(repoRoot, args as { path: string });
      case 'write_file':
        return writeFile(repoRoot, args as { path: string; content: string });
      case 'list_files':
        return listFiles(repoRoot, args as { pattern?: string });
      case 'search_files':
        return searchFiles(repoRoot, args as { pattern: string; glob?: string });
      case 'run_command':
        return runCommand(repoRoot, args as { command: string }, ui.confirm);
      default:
        // Unreachable: every definition except report is dispatched above.
        return { ok: false, error: `tool "${name}" has no implementation`, malformed: true };
    }
  };

  return { role, definitions, validateReport, execute };
}
