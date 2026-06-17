/**
 * Terminal UI: a thin wrapper over node:readline/promises.
 *
 * All interaction is expressed through the UI interface so the orchestrator,
 * phases, and tools receive it as an injected dependency and tests can
 * substitute scripted answers without a TTY.
 */
import * as readline from 'node:readline/promises';
import { coloursEnabled, makePalette } from './colour';

/**
 * The result of a choice prompt: either a predefined option (with an optional
 * attached note) or a free-text response chosen via "Something else...".
 */
export type ChoiceResult =
  | { option: string; note?: string }
  | { freeText: string };

/** The literal label of the final "Something else..." menu item. */
export const SOMETHING_ELSE = 'Something else...';

export interface UI {
  /** Ask a free-form question and return the trimmed answer. */
  ask(question: string): Promise<string>;
  /** Ask a yes/no question; returns true for yes, false for no. */
  confirm(question: string): Promise<boolean>;
  /** Present a numbered list of options and return the chosen option. */
  select(label: string, options: string[]): Promise<string>;
  /**
   * Print the message as an agent block (a hint and the message, blank line
   * above), then read a multi-line answer behind a "you> " marker ("...> " on
   * continuation lines). Every line is kept verbatim, INCLUDING blank lines,
   * so pasted content with internal blank lines survives intact. The answer is
   * submitted with Ctrl-D (EOF) or a line containing only "." — a blank line is
   * no longer a submit. Lines are returned joined with newlines, with trailing
   * blank lines dropped.
   */
  readAnswer(message: string): Promise<string>;
  /**
   * Present a numbered menu of options plus a final "Something else..." item.
   * A bare number selects that option; a number followed by free text selects
   * the option and attaches the trailing text as a note. Choosing
   * "Something else..." returns a free-text response (its trailing text, or a
   * single-line prompt when none was typed). Invalid input re-prompts.
   */
  choose(label: string, options: string[]): Promise<ChoiceResult>;
  /**
   * Ask a yes/no question as a two-option Yes/No menu (built on the same choice
   * grammar as `choose`), returning the boolean plus any attached note. As well
   * as the menu numbers, it accepts `y`/`n` and `yes`/`no` (case-insensitive)
   * as aliases for the two options, still with optional-note support
   * (e.g. `y rebuild first` -> { yes: true, note: 'rebuild first' }).
   */
  confirmWithNote(question: string): Promise<{ yes: boolean; note?: string }>;
}

/**
 * Build a UI backed by readline over the given streams (default: the
 * process stdin/stdout). For single-line prompts a fresh readline interface
 * is created per question so stdin is not held open between prompts;
 * readAnswer instead holds ONE interface open for the whole answer so a
 * multi-line paste is consumed line by line instead of leaking buffered
 * lines into later prompts.
 */
export function createReadlineUI(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): UI {
  const askRaw = async (prompt: string): Promise<string> => {
    const rl = readline.createInterface({ input, output });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  };

  const ask = async (question: string): Promise<string> =>
    (await askRaw(`${question} `)).trim();

  const confirm = async (question: string): Promise<boolean> => {
    for (;;) {
      const answer = (await askRaw(`${question} [y/n] `)).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      output.write('Please answer y or n.\n');
    }
  };

  const select = async (label: string, options: string[]): Promise<string> => {
    if (options.length === 0) {
      throw new Error(`select "${label}": no options to choose from`);
    }
    for (;;) {
      output.write(`${label}\n`);
      options.forEach((option, index) => {
        output.write(`  ${index + 1}. ${option}\n`);
      });
      const answer = (await askRaw(`Choose 1-${options.length}: `)).trim();
      const choice = Number(answer);
      if (Number.isInteger(choice) && choice >= 1 && choice <= options.length) {
        return options[choice - 1];
      }
      output.write(`Invalid choice: ${answer}\n`);
    }
  };

  /**
   * Render a numbered menu (the options plus a final "Something else..." item)
   * and read one line, parsing it into a ChoiceResult. The grammar lives here
   * in one place: a leading integer is the choice number, and any text after
   * the number (trimmed) is an optional note. Valid numbers are
   * 1..options.length + 1, where the last slot is the free-text escape; any
   * other input re-prompts. Choosing the escape with trailing text returns it
   * directly as free text; with no trailing text a single-line prompt is opened.
   *
   * The optional `resolveAlias` hook lets a caller (confirmWithNote) translate a
   * non-numeric line into the equivalent numeric input BEFORE it is parsed by
   * the numeric grammar above. This keeps caller-specific aliases (y/n/yes/no)
   * out of the generic `choose` grammar, which stays numeric-only: `choose`
   * simply does not pass a resolver.
   */
  const choosePrompt = async (
    label: string,
    options: string[],
    resolveAlias?: (line: string) => string | undefined,
  ): Promise<ChoiceResult> => {
    if (options.length === 0) {
      throw new Error(`choose "${label}": no options to choose from`);
    }
    const items = [...options, SOMETHING_ELSE];
    const elseNumber = items.length;
    for (;;) {
      output.write(`${label}\n`);
      items.forEach((item, index) => {
        output.write(`  ${index + 1}. ${item}\n`);
      });
      const raw = (await askRaw(`Choose 1-${items.length}: `)).trim();
      // A caller-supplied resolver may rewrite an alias line (e.g. "y note")
      // into the numeric form ("1 note") before the numeric grammar runs.
      const answer = resolveAlias?.(raw) ?? raw;
      const match = /^(\d+)(.*)$/.exec(answer);
      const choice = match ? Number(match[1]) : NaN;
      if (Number.isInteger(choice) && choice >= 1 && choice <= elseNumber) {
        const note = match ? match[2].trim() : '';
        if (choice === elseNumber) {
          if (note !== '') return { freeText: note };
          const freeText = (await askRaw('Your response: ')).trim();
          return { freeText };
        }
        return note === ''
          ? { option: options[choice - 1] }
          : { option: options[choice - 1], note };
      }
      output.write(`Invalid choice: ${answer}\n`);
    }
  };

  const choose = (label: string, options: string[]): Promise<ChoiceResult> =>
    choosePrompt(label, options);

  // The Yes/No menu's option order; Yes is option 1, No is option 2.
  const CONFIRM_OPTIONS = ['Yes', 'No'];

  const confirmWithNote = async (
    question: string,
  ): Promise<{ yes: boolean; note?: string }> => {
    // Translate a leading y/yes/n/no token (case-insensitive) into the matching
    // menu number, carrying the rest of the line through as the note. This is a
    // confirmWithNote-only convenience: choose stays numeric-only.
    const resolveAlias = (line: string): string | undefined => {
      const match = /^(y|yes|n|no)(\s.*)?$/i.exec(line);
      if (!match) return undefined;
      const number = /^y(es)?$/i.test(match[1]) ? '1' : '2';
      return `${number}${match[2] ?? ''}`;
    };
    const result = await choosePrompt(question, CONFIRM_OPTIONS, resolveAlias);
    // The Yes/No menu has no meaningful "Something else..." branch, but the
    // shared grammar always offers it; treat a free-text escape as a note-only
    // response that is neither yes nor no by re-deriving from the option.
    if ('option' in result) {
      const yes = result.option === 'Yes';
      return result.note === undefined ? { yes } : { yes, note: result.note };
    }
    // A user who escaped to free text gave no yes/no; map the escape's text to a
    // declining answer carrying the text as the note (no gate uses this path —
    // confirm call sites only script y/n/menu input — but the shared helper
    // guarantees this branch is reachable, so it is handled explicitly).
    return { yes: false, note: result.freeText };
  };

  const palette = makePalette(coloursEnabled(output));
  // A line containing only this submits the answer (the typeable equivalent of
  // Ctrl-D). A bare blank line is NOT a submit, so pasted blank lines survive.
  const SUBMIT_SENTINEL = '.';

  const readAnswer = (message: string): Promise<string> => {
    output.write(
      `\n${palette.hint('(line breaks are kept — submit with Ctrl-D, or a "." on its own line)')}\n`,
    );
    output.write(`${palette.agent(message)}\n`);
    // One interface for the entire answer: rl.question-per-line would let a
    // multi-line paste emit lines while no listener is attached, dropping or
    // misrouting everything after the first line.
    const rl = readline.createInterface({ input, output });
    return new Promise(resolve => {
      const lines: string[] = [];
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        rl.close();
        // Drop trailing blank lines (e.g. a paste's trailing newline) but keep
        // blank lines that sit between content.
        while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        resolve(lines.join('\n'));
      };
      // The first line shows a plain "you> "; once the answer spans multiple
      // lines, each continuation marker carries a label so the user knows the
      // response has NOT been submitted and how to submit it.
      const youMarker = palette.user('you> ');
      const continueMarker = `${palette.hint('(keep writing, or Ctrl-D to submit)')} ${palette.user('...> ')}`;
      const showPrompt = (marker: string): void => {
        rl.setPrompt(marker);
        rl.prompt();
      };
      showPrompt(youMarker);
      rl.on('line', line => {
        if (done) return;
        if (line === SUBMIT_SENTINEL) {
          finish();
          return;
        }
        lines.push(line); // every line, including blanks, is content
        showPrompt(continueMarker);
      });
      // EOF (Ctrl-D) submits whatever was collected so far.
      rl.on('close', finish);
    });
  };

  return { ask, confirm, select, readAnswer, choose, confirmWithNote };
}
