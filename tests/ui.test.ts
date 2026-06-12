import { describe, test, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createReadlineUI, UI } from '../src/ui';

/** Harness: a readline UI driven by in-memory streams, no TTY required. */
function makeUI(): { ui: UI; input: PassThrough; getOutput: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', chunk => {
    written += String(chunk);
  });
  const ui = createReadlineUI(input, output);
  return { ui, input, getOutput: () => written };
}

/** Poll until the predicate holds; fails the test if it never does. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor: timed out waiting for ${what}`);
}

describe('createReadlineUI.readAnswer', () => {
  test('prints the message with a blank line above, then a "you> " marker', async () => {
    const { ui, input, getOutput } = makeUI();
    const promise = ui.readAnswer('What should the feature do?');
    await waitFor(() => getOutput().includes('you> '), 'the you> marker');
    // Blank line, then the message on its own line, then the marker.
    expect(getOutput()).toContain('\nWhat should the feature do?\nyou> ');
    input.write('Make it fast.\n\n');
    expect(await promise).toBe('Make it fast.');
  });

  test('marks continuation lines with "...> "', async () => {
    const { ui, input, getOutput } = makeUI();
    const promise = ui.readAnswer('Question?');
    input.write('first\nsecond\nthird\n\n');
    expect(await promise).toBe('first\nsecond\nthird');
    // One "you> " for the first line, then "...> " after every accepted line.
    expect(getOutput().match(/you> /g)).toHaveLength(1);
    expect(getOutput().match(/\.\.\.> /g)).toHaveLength(3);
  });

  test('a 5-line paste arrives verbatim as ONE string, and no residue leaks into a later prompt', async () => {
    const { ui, input } = makeUI();
    // Pre-write the whole paste (plus the submitting empty line) as a single
    // chunk, the way a terminal paste lands in stdin.
    input.write('l1\nl2\nl3\nl4\nl5\n\n');
    const answer = await ui.readAnswer('Paste your notes.');
    expect(answer).toBe('l1\nl2\nl3\nl4\nl5');

    // A later prompt sees only fresh input, not paste residue.
    const askPromise = ui.ask('Anything else?');
    input.write('fresh input\n');
    expect(await askPromise).toBe('fresh input');
  });

  test('keeps lines verbatim: surrounding whitespace is not trimmed', async () => {
    const { ui, input } = makeUI();
    const promise = ui.readAnswer('Question?');
    input.write('  indented\ttext  \n\n');
    expect(await promise).toBe('  indented\ttext  ');
  });

  test('an empty first line returns the empty string', async () => {
    const { ui, input } = makeUI();
    const promise = ui.readAnswer('Question?');
    input.write('\n');
    expect(await promise).toBe('');
  });

  test('end of input submits whatever was collected', async () => {
    const { ui, input } = makeUI();
    const promise = ui.readAnswer('Question?');
    input.write('only line\n');
    input.end();
    expect(await promise).toBe('only line');
  });
});

describe('createReadlineUI regressions: ask/confirm/select unchanged', () => {
  test('ask prompts with the question and returns the trimmed answer', async () => {
    const { ui, input, getOutput } = makeUI();
    const promise = ui.ask('Your name?');
    input.write('  Ada \n');
    expect(await promise).toBe('Ada');
    expect(getOutput()).toContain('Your name? ');
  });

  test('confirm re-prompts on junk, then accepts y', async () => {
    const { ui, input, getOutput } = makeUI();
    const promise = ui.confirm('Proceed?');
    input.write('maybe\n');
    await waitFor(() => getOutput().includes('Please answer y or n.'), 'the re-prompt');
    input.write('y\n');
    expect(await promise).toBe(true);
  });

  test('select lists options, rejects an invalid choice, and returns the picked option', async () => {
    const { ui, input, getOutput } = makeUI();
    const promise = ui.select('Pick one', ['alpha', 'beta']);
    input.write('7\n');
    await waitFor(() => getOutput().includes('Invalid choice: 7'), 'the invalid-choice message');
    input.write('2\n');
    expect(await promise).toBe('beta');
    expect(getOutput()).toContain('  1. alpha');
    expect(getOutput()).toContain('  2. beta');
  });
});
