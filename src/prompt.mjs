// Asking, and reading a flag - the two things every command does before it does anything.
//
// They live here rather than in whichever command needed them first: `init` offers to write the
// soul and `soul` writes it, so a shared home is the only way those two do not import each other.

import {createInterface} from 'node:readline/promises';

/**
 * `--token 0x...` or `--token=0x...`; undefined when the flag is absent OR carries no value.
 *
 * The next argument is only a value when it is not itself a flag. Taking one blindly turns
 * `--out --yes` into a file named `--yes` - which, in the one command that prints a private key,
 * means the file is never written and the key goes to the screen instead.
 */
export function flagValue(argv, name) {
  const at = argv.indexOf(`--${name}`);
  if (at !== -1) {
    const next = argv[at + 1];
    return next === undefined || next.startsWith('--') ? undefined : next;
  }
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined ? joined.slice(name.length + 3) : undefined;
}

export async function ask(question) {
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    return (await rl.question(question)).trim();
  } catch {
    // Ctrl+D at the prompt is an answer - "not now" - and whatever came before it already
    // happened. Failing here would report that nothing did.
    process.stdout.write('\n');
    return '';
  } finally {
    rl.close();
  }
}
