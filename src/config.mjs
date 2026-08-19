// The agent's standing answers - what it should never have to be told twice.
//
// Today that is one line, the agent's own token, and it is worth a file because the alternative
// is an address pasted into every command: the one place a typo turns a read about YOU into a
// read about a stranger, silently and with a perfectly plausible answer.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

export function configPath() {
  return process.env.KAIRENCE_CONFIG_FILE || `${process.env.HOME}/.kairence/config.json`;
}

export function readConfig(path = configPath()) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not readable JSON - delete it and run \`kairence init\``);
  }
}

/** Merges into what is already there: a future key must not be dropped by an old release. */
export function saveConfig(patch, path = configPath()) {
  const next = {...readConfig(path), ...patch};
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, {mode: 0o600});
  return next;
}
