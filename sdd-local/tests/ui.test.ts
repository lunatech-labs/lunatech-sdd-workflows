import { describe, test, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createReadlineUI, UI, SOMETHING_ELSE, ChoiceResult } from '../src/ui';

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
    // The message sits on its own line immediately above the marker.
    expect(getOutput()).toContain('\nWhat should the feature do?\nyou> ');
    // A "." on its own line submits.
    input.write('Make it fast.\n.\n');
    expect(await promise).toBe('Make it fast.');
  });

  test('marks continuation lines with "...> "', async () => {
    const { ui, input, getOutput } = makeUI();
    const promise = ui.readAnswer('Question?');
    input.write('first\nsecond\nthird\n.\n');
    expect(await promise).toBe('first\nsecond\nthird');
    // One "you> " for the first line, then "...> " after every accepted line.
    expect(getOutput().match(/you> /g)).toHaveLength(1);
    expect(getOutput().match(/\.\.\.> /g)).toHaveLength(3);
    // The continuation marker carries a submit label.
    expect(getOutput()).toContain('Ctrl-D to submit');
  });

  test('a 5-line paste arrives verbatim as ONE string, and no residue leaks into a later prompt', async () => {
    const { ui, input } = makeUI();
    // Pre-write the whole paste plus the submitting "." line as a single
    // chunk, the way a terminal paste lands in stdin.
    input.write('l1\nl2\nl3\nl4\nl5\n.\n');
    const answer = await ui.readAnswer('Paste your notes.');
    expect(answer).toBe('l1\nl2\nl3\nl4\nl5');

    // A later prompt sees only fresh input, not paste residue.
    const askPromise = ui.ask('Anything else?');
    input.write('fresh input\n');
    expect(await askPromise).toBe('fresh input');
  });

  test('keeps blank lines that sit between content (paste survives intact)', async () => {
    const { ui, input } = makeUI();
    const promise = ui.readAnswer('Question?');
    input.write('para 1\n\npara 2\n.\n');
    expect(await promise).toBe('para 1\n\npara 2');
  });

  test('drops trailing blank lines (e.g. a paste ending in newlines)', async () => {
    const { ui, input } = makeUI();
    const promise = ui.readAnswer('Question?');
    input.write('content\n\n\n.\n');
    expect(await promise).toBe('content');
  });

  test('keeps lines verbatim: surrounding whitespace is not trimmed', async () => {
    const { ui, input } = makeUI();
    const promise = ui.readAnswer('Question?');
    input.write('  indented\ttext  \n.\n');
    expect(await promise).toBe('  indented\ttext  ');
  });

  test('submitting immediately (a lone ".") returns the empty string', async () => {
    const { ui, input } = makeUI();
    const promise = ui.readAnswer('Question?');
    input.write('.\n');
    expect(await promise).toBe('');
  });

  test('end of input (Ctrl-D) submits whatever was collected', async () => {
    const { ui, input } = makeUI();
    const promise = ui.readAnswer('Question?');
    input.write('only line\n');
    input.end();
    expect(await promise).toBe('only line');
  });
});

describe('createReadlineUI.choose', () => {
  test('AC1: a bare option number returns that option with no note', async () => {
    const { ui, input } = makeUI();
    const promise = ui.choose('Pick one', ['alpha', 'beta', 'gamma']);
    input.write('2\n');
    const result = await promise;
    expect(result).toEqual({ option: 'beta' });
    // No note key was attached.
    expect('note' in result && result.note !== undefined).toBe(false);
  });

  test('AC1: a number followed only by whitespace is a bare selection (no note)', async () => {
    const { ui, input } = makeUI();
    const promise = ui.choose('Pick one', ['alpha', 'beta', 'gamma']);
    input.write('1   \n');
    const result = await promise;
    expect(result).toEqual({ option: 'alpha' });
  });

  test('AC2: a number plus trailing text returns the option and the trimmed note', async () => {
    const { ui, input } = makeUI();
    const promise = ui.choose('Pick one', ['alpha', 'beta', 'gamma']);
    input.write('2 needs more tests\n');
    const result = await promise;
    expect(result).toEqual({ option: 'beta', note: 'needs more tests' });
  });

  test('AC3: the final "Something else..." item opens a free-text prompt and returns { freeText }', async () => {
    const { ui, input, getOutput } = makeUI();
    const promise = ui.choose('Pick one', ['alpha', 'beta']);
    // The free-text escape is the last menu item, so option count + 1.
    expect(getOutput).toBeTypeOf('function');
    // Select "Something else..." with no trailing text -> a free-text prompt opens.
    input.write('3\n');
    await waitFor(() => getOutput().includes(SOMETHING_ELSE), 'the Something else item rendered');
    // Now the free-text prompt is awaiting a single line.
    input.write('my own answer\n');
    const result = await promise;
    expect(result).toEqual({ freeText: 'my own answer' });
    // Distinguishable from a predefined option: no `option` key.
    expect('option' in result).toBe(false);
  });

  test('AC3: "Something else..." with trailing text uses that text directly as the free text', async () => {
    const { ui, input } = makeUI();
    const promise = ui.choose('Pick one', ['alpha', 'beta']);
    // <N+1> my own answer -> trailing text is the free text, no second prompt.
    input.write('3 my own answer\n');
    const result = await promise;
    expect(result).toEqual({ freeText: 'my own answer' });
  });

  test('AC4: invalid inputs (0, past-last-number, abc, empty) re-prompt, then a valid choice is accepted', async () => {
    const { ui, input, getOutput } = makeUI();
    const promise = ui.choose('Pick one', ['alpha', 'beta']);
    // Valid numeric range is 1..3 (two options + "Something else...").
    input.write('0\n');
    await waitFor(() => getOutput().includes('0'), 'the menu echoing the 0 attempt');
    input.write('4\n'); // past the last number (N+1 = 3 is the last valid)
    input.write('abc\n');
    input.write('\n'); // empty
    // None of those should have resolved the promise yet.
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    // A valid choice is finally accepted.
    input.write('1\n');
    const result = await promise;
    expect(result).toEqual({ option: 'alpha' });
  });
});

describe('createReadlineUI.confirmWithNote', () => {
  test('AC9: a "yes" answer returns { yes: true } and proceeds', async () => {
    const { ui, input } = makeUI();
    const promise = ui.confirmWithNote('Proceed?');
    input.write('yes\n');
    const result = await promise;
    expect(result).toEqual({ yes: true });
  });

  test('AC9: a "no" answer returns { yes: false } and declines', async () => {
    const { ui, input } = makeUI();
    const promise = ui.confirmWithNote('Proceed?');
    input.write('no\n');
    const result = await promise;
    expect(result).toEqual({ yes: false });
  });

  test('AC9: a yes with an attached note returns { yes: true, note }', async () => {
    const { ui, input } = makeUI();
    const promise = ui.confirmWithNote('Proceed?');
    input.write('y rebuild first\n');
    const result = await promise;
    expect(result).toEqual({ yes: true, note: 'rebuild first' });
  });

  test('AC9: aliases map "y" -> yes and "n" -> no (case-insensitive)', async () => {
    const yesUI = makeUI();
    const yesPromise = yesUI.ui.confirmWithNote('Proceed?');
    yesUI.input.write('Y\n');
    expect(await yesPromise).toEqual({ yes: true });

    const noUI = makeUI();
    const noPromise = noUI.ui.confirmWithNote('Proceed?');
    noUI.input.write('N\n');
    expect(await noPromise).toEqual({ yes: false });
  });

  test('AC9: the menu numbers also work (1 = Yes, 2 = No)', async () => {
    const { ui, input, getOutput } = makeUI();
    const promise = ui.confirmWithNote('Proceed?');
    input.write('1\n');
    expect(await promise).toEqual({ yes: true });
    // The Yes/No options are rendered as a numbered menu.
    expect(getOutput()).toContain('1. Yes');
    expect(getOutput()).toContain('2. No');
  });
});

describe('createReadlineUI regressions: ask/confirm/select unchanged', () => {
  test('confirm still returns a boolean (not a { yes } object)', async () => {
    const { ui, input } = makeUI();
    const promise = ui.confirm('Proceed?');
    input.write('y\n');
    const result = await promise;
    expect(result).toBe(true);
    expect(typeof result).toBe('boolean');
  });

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
