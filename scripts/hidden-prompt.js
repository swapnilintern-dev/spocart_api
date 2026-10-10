// Reading a secret from a terminal without echoing it.
//
// Its own module so it can be unit-tested with a fake stream: the first two
// attempts at this lived inside the script, could only be exercised by typing
// at a real terminal, and shipped broken twice because of it.
/**
 * One hidden line from a terminal.
 *
 * Raw mode and our own keypress loop, rather than readline: hiding the echo
 * through readline means reaching for `_writeToOutput`, a private field that
 * does not exist on every Node version — which is exactly how this script
 * broke once already.
 */
export function askHidden(question, stdin = process.stdin, onInterrupt = () => process.exit(130)) {
  return new Promise((resolve) => {
    process.stdout.write(question);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const done = (result, interrupted) => {
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (interrupted) return onInterrupt();
      resolve(result);
    };

    const onData = (chunk) => {
      // A paste, or a multi-byte key, arrives as several characters at once.
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === '\u0004') return done(value);
        if (char === '\u0003') return done('', true);          // Ctrl-C
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };

    stdin.on('data', onData);
  });
}
