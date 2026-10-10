// The hidden password prompt. This is the path a real terminal takes, and it
// is the part of the admin-password script that shipped broken twice — once
// hanging on its second question, once calling a private readline field that
// does not exist on Node 24. Both would have been caught here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { askHidden } from '../scripts/hidden-prompt.js';

/// Stands in for a TTY stdin: records raw mode, and lets a test feed keys.
class FakeTty extends EventEmitter {
  constructor() {
    super();
    this.isRaw = false;
    this.rawCalls = [];
    this.paused = false;
    this.encoding = null;
  }

  setRawMode(value) {
    this.isRaw = value;
    this.rawCalls.push(value);
    return this;
  }

  resume() { this.paused = false; return this; }
  pause() { this.paused = true; return this; }
  setEncoding(enc) { this.encoding = enc; return this; }

  type(text) { this.emit('data', text); }
}

let writes;

beforeEach(() => {
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
});

afterEach(() => vi.restoreAllMocks());

describe('askHidden', () => {
  it('resolves what was typed when Enter is pressed', async () => {
    const tty = new FakeTty();
    const answer = askHidden('pw: ', tty);
    tty.type('secret-password\n');
    expect(await answer).toBe('secret-password');
  });

  it('prints the prompt but never the typing', async () => {
    const tty = new FakeTty();
    const answer = askHidden('  New password: ', tty);
    tty.type('secret-password\r');
    await answer;

    const printed = writes.join('');
    expect(printed).toContain('New password:');
    expect(printed).not.toContain('secret-password');
  });

  it('turns raw mode on, and puts it back afterwards', async () => {
    const tty = new FakeTty();
    const answer = askHidden('pw: ', tty);
    expect(tty.isRaw).toBe(true);
    tty.type('abc\n');
    await answer;
    expect(tty.isRaw).toBe(false);
    expect(tty.rawCalls).toEqual([true, false]);
  });

  it('handles a password arriving one keystroke at a time', async () => {
    const tty = new FakeTty();
    const answer = askHidden('pw: ', tty);
    for (const ch of 'typed-slowly') tty.type(ch);
    tty.type('\n');
    expect(await answer).toBe('typed-slowly');
  });

  it('handles a paste arriving as one chunk', async () => {
    const tty = new FakeTty();
    const answer = askHidden('pw: ', tty);
    tty.type('pasted-all-at-once\n');
    expect(await answer).toBe('pasted-all-at-once');
  });

  it('backspace deletes the last character', async () => {
    const tty = new FakeTty();
    const answer = askHidden('pw: ', tty);
    tty.type('passwordX');
    tty.type('\u007f');
    tty.type('\n');
    expect(await answer).toBe('password');
  });

  it('backspace on an empty value does not go negative', async () => {
    const tty = new FakeTty();
    const answer = askHidden('pw: ', tty);
    tty.type('\u007f\u007f\u007f');
    tty.type('ok-after-backspace\n');
    expect(await answer).toBe('ok-after-backspace');
  });

  it('ignores control characters that are not keys we handle', async () => {
    const tty = new FakeTty();
    const answer = askHidden('pw: ', tty);
    tty.type('\u001b'); // a stray escape
    tty.type('clean-password\n');
    expect(await answer).toBe('clean-password');
  });

  it('Ctrl-C interrupts instead of resolving', async () => {
    const tty = new FakeTty();
    const onInterrupt = vi.fn();
    const answer = askHidden('pw: ', tty, onInterrupt);
    tty.type('half-typed');
    tty.type('\u0003');

    await Promise.race([answer, new Promise((r) => setTimeout(r, 20))]);
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(tty.isRaw).toBe(false);
  });

  it('stops listening once answered, so the next prompt gets the keys', async () => {
    const tty = new FakeTty();
    const first = askHidden('pw: ', tty);
    tty.type('first-answer\n');
    expect(await first).toBe('first-answer');
    expect(tty.listenerCount('data')).toBe(0);

    // This is the bug that made the script hang: a second prompt must work.
    const second = askHidden('again: ', tty);
    tty.type('second-answer\n');
    expect(await second).toBe('second-answer');
  });
});
