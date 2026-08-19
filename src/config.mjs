// The standing answers for ONE agent - what it should never have to be told twice.
//
// The token itself is no longer written down: it is the name of the room the file sits in, which
// is one fewer place for the two to disagree. What is left is the account this machine does not
// hold a key for, when the agent brought a wallet of its own.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileFor, legacyFile, legacyToken} from './home.mjs';

export function configPath(token) {
  if (process.env.KAIRENCE_CONFIG_FILE) return process.env.KAIRENCE_CONFIG_FILE;
  if (!token) return legacyFile('config.json');
  const own = fileFor(token, 'config.json');
  if (existsSync(own)) return own;
  const legacy = legacyToken();
  if (legacy && legacy.toLowerCase() === token.toLowerCase()) return legacyFile('config.json');
  return own;
}

export function readConfig(token) {
  const path = configPath(token);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not readable JSON - delete it and run \`kairence init\``);
  }
}

/** Merges into what is already there: a future key must not be dropped by an old release. */
export function saveConfig(patch, token) {
  const path = configPath(token);
  const next = {...readConfig(token), ...patch};
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, {mode: 0o600});
  return next;
}
