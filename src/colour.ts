/**
 * Minimal ANSI colour helpers, used to visually separate agent output from
 * user input in the terminal. Colour is applied only when the target stream
 * is a TTY and NO_COLOR is unset, so piped/redirected output and tests (which
 * drive in-memory streams) stay plain text.
 */

const ANSI = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m', // agent output / model text / progress
  greenBold: '\x1b[32;1m', // the user input prompt
  dim: '\x1b[2m', // hints
} as const;

export interface Palette {
  /** Agent side: model text, questions, [role] progress lines. */
  agent(text: string): string;
  /** The user input prompt (you> / ...>). */
  user(text: string): string;
  /** Dim hint text. */
  hint(text: string): string;
}

/** True when colour should be emitted to this stream. */
export function coloursEnabled(stream: NodeJS.WritableStream): boolean {
  return Boolean((stream as Partial<NodeJS.WriteStream>).isTTY) && !process.env.NO_COLOR;
}

/** Build a palette; when disabled, every helper returns its input unchanged. */
export function makePalette(enabled: boolean): Palette {
  const wrap = (code: string) => (text: string) => (enabled ? `${code}${text}${ANSI.reset}` : text);
  return {
    agent: wrap(ANSI.cyan),
    user: wrap(ANSI.greenBold),
    hint: wrap(ANSI.dim),
  };
}
