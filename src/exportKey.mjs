// `kairence export-private-key` - the one door that hands the key back.
//
// It exists because a key with no way out is a key the human cannot rescue: moving the agent to a
// new machine, opening its account in a wallet, sweeping the last of its gas. The command is named
// for what it does rather than what it is for, so it can never be run by accident of phrasing.
//
// Every guard here is about the SCREEN, not the caller: the danger is not that the agent asked,
// it is a key landing in a transcript, a log or a shell history that outlives the machine. So the
// safe form writes a 0600 file, printing needs saying so twice, and a pipe is refused outright.

import {writeFileSync} from 'node:fs';
import {privateKeyToAccount} from 'viem/accounts';
import {readConfig} from './config.mjs';
import {ask, flagValue} from './init.mjs';
import {keyPath, readKey} from './key.mjs';

export async function exportPrivateKey(argv) {
  const path = keyPath();
  const out = flagValue(argv, 'out');
  const yes = argv.includes('--yes');
  const key = readKey(path);

  if (key === null) {
    const external = readConfig().externalAccount;
    throw new Error(
      external
        ? `your account ${external} is held elsewhere - there is no key here to export`
        : 'you have no account key yet - run `kairence init`',
    );
  }
  const {address} = privateKeyToAccount(key);

  if (out) {
    try {
      // 'wx' fails rather than overwriting: the file it would eat is, by the nature of this
      // command, another private key.
      writeFileSync(out, `${key}\n`, {flag: 'wx', mode: 0o600});
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      throw new Error(`${out} already exists - a file this command would overwrite is a key too, so pick another name`);
    }
    console.log(`The key for ${address} is in ${out} (readable only by you).`);
    console.log(`Hand that file to your human and delete it. Anyone holding it IS you.`);
    return;
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      throw new Error(
        'refusing to print a private key into a pipe - write it to a file with `--out <file>`, or pass --yes if you truly meant to print it',
      );
    }
    console.log(`This prints the private key for ${address} on this screen.`);
    console.log(`Whatever is recording this session - a log, a transcript, your scrollback - keeps it.`);
    console.log(`\`kairence export-private-key --out <file>\` is the quiet way.\n`);
    if ((await ask('Type yes to print it anyway: ')).toLowerCase() !== 'yes') {
      console.log('Nothing printed.');
      return;
    }
  }

  console.log(key);
}
