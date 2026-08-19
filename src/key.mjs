// The agent's account key on this machine: where it lives, how it is minted, how it is retired.
//
// The key is a HAND, not a vault. It signs the agent's calls (its journal, its own money doors)
// and holds gas and whatever it just pulled - never a balance worth stealing. That is deliberate:
// if the machine dies, the human re-points the account with one `AgentRegistry.setAgent` call and
// nothing of value was ever on it. So the key is cheap to lose and cheap to replace.
//
// Every path here is keyed by the agent's token, because one machine can hold several agents.
// Nothing here prints. The key leaves this module through `readKey`, and the only caller allowed
// to put it on a screen is `export-private-key`, where the agent asked for exactly that.

import {chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {dirFor, fileFor, legacyFile, legacyToken} from './home.mjs';

const KEY = /^0x[0-9a-fA-F]{64}$/;

/**
 * Where this agent's key is. KAIRENCE_KEY_FILE still wins, as the single-agent escape hatch, and
 * the flat layout is honoured when it is the only thing that exists.
 */
export function keyPath(token) {
  if (process.env.KAIRENCE_KEY_FILE) return process.env.KAIRENCE_KEY_FILE;
  if (!token) return legacyFile('agent.pk');
  const own = fileFor(token, 'agent.pk');
  if (existsSync(own)) return own;
  const legacy = legacyToken();
  if (legacy && legacy.toLowerCase() === token.toLowerCase()) return legacyFile('agent.pk');
  return own;
}

/**
 * The private key, or null when this machine holds none for that agent.
 *
 * An agent that arrived with its own key needs no import command: writing it to this file IS the
 * import, which is why the check here is a shape check and not a check that we minted it.
 */
export function readKey(token) {
  const path = keyPath(token);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  if (!KEY.test(raw)) {
    throw new Error(`${path} does not hold a private key - move it aside and run \`kairence init\``);
  }
  return raw;
}

/** The address of the standing key, or null when there is none. Never returns the key itself. */
export function currentAddress(token) {
  const key = readKey(token);
  return key === null ? null : privateKeyToAccount(key).address;
}

export function mint(token) {
  const path = keyPath(token);
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
export function retire(token) {
  const path = keyPath(token);
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

/** What this machine calls itself for one agent: the key it holds, else the address it was told. */
export function myAddress(token, config = {}) {
  try {
    return currentAddress(token) || config.externalAccount || null;
  } catch {
    // A corrupt key file is `init`'s problem to report, not a reason to blank an unrelated report.
    return config.externalAccount || null;
  }
}

/** Make sure the agent has a room before anything is written into it. */
export function ensureRoom(token) {
  mkdirSync(dirFor(token), {recursive: true, mode: 0o700});
}
