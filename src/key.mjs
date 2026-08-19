// The agent's account key on this machine: where it lives, how it is minted, how it is retired.
//
// The key is a HAND, not a vault. It signs the agent's calls (its journal, its own money doors)
// and holds gas and whatever it just pulled - never a balance worth stealing. That is deliberate:
// if the machine dies, the human re-points the account with one `AgentRegistry.setAgent` call and
// nothing of value was ever on it. So the key is cheap to lose and cheap to replace.
//
// Nothing here prints. The key leaves this module through `readKey`, and the only caller allowed
// to put it on a screen is `export-private-key`, where the agent asked for exactly that.

import {chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';

const KEY = /^0x[0-9a-fA-F]{64}$/;

export function keyPath() {
  return process.env.KAIRENCE_KEY_FILE || `${process.env.HOME}/.kairence/agent.pk`;
}

/**
 * The private key, or null when this machine holds none.
 *
 * An agent that arrived with its own key needs no import command: writing it to this file IS the
 * import, which is why the check here is a shape check and not a check that we minted it.
 */
export function readKey(path = keyPath()) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  if (!KEY.test(raw)) {
    throw new Error(`${path} does not hold a private key - move it aside and run \`kairence init\``);
  }
  return raw;
}

/** The address of the standing key, or null when there is none. Never returns the key itself. */
export function currentAddress(path = keyPath()) {
  const key = readKey(path);
  return key === null ? null : privateKeyToAccount(key).address;
}

export function mint(path = keyPath()) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const pk = generatePrivateKey();
  // mode on write AND an explicit chmod: a permissive umask would otherwise widen the file
  // between creation and the first byte landing in it.
  writeFileSync(path, `${pk}\n`, {mode: 0o600});
  chmodSync(path, 0o600);
  return privateKeyToAccount(pk).address;
}

/**
 * Move the standing key aside and return where it went. Every retired key is kept: until the human
 * re-points `AgentRegistry.setAgent`, the OLD key is still the account, so deleting one throws away
 * the agent's voice and whatever gas sat on it.
 *
 * `link` + `unlink` rather than `rename`: rename clobbers its destination without a word, and two
 * rotations landing on one name would eat a key that is still live. The counter is the retry for
 * exactly that collision.
 */
export function retire(path = keyPath()) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  for (let n = 1; n <= 100; n++) {
    const candidate = n === 1 ? `${path}.retired-${stamp}` : `${path}.retired-${stamp}-${n}`;
    try {
      linkSync(path, candidate);
      unlinkSync(path);
      return candidate;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`cannot retire ${path} - a hundred retired keys already carry this timestamp`);
}

/** What this machine calls itself: the key it holds, else the address it was told to answer to. */
export function myAddress(config) {
  try {
    return currentAddress() || config.externalAccount || null;
  } catch {
    // A corrupt key file is `init`'s problem to report, not a reason to blank an unrelated report.
    return config.externalAccount || null;
  }
}
