/**
 * Terminal UI: a thin wrapper over node:readline/promises.
 *
 * All interaction is expressed through the UI interface so the orchestrator,
 * phases, and tools receive it as an injected dependency and tests can
 * substitute scripted answers without a TTY.
 */
import * as readline from 'node:readline/promises';

export interface UI {
  /** Ask a free-form question and return the trimmed answer. */
  ask(question: string): Promise<string>;
  /** Ask a yes/no question; returns true for yes, false for no. */
  confirm(question: string): Promise<boolean>;
  /** Present a numbered list of options and return the chosen option. */
  select(label: string, options: string[]): Promise<string>;
}

/**
 * Build a UI backed by readline over the given streams (default: the
 * process stdin/stdout). A fresh readline interface is created per question
 * so stdin is not held open between prompts.
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

  return { ask, confirm, select };
}
