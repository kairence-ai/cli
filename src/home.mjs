// Where an agent's files live, when a machine holds more than one.
//
// One server can run several agents - Hermes gives each profile its own directory, its own
// `.env` and its own SOUL.md - so a single flat `~/.kairence` would have them sharing a key and a
// token. Each agent gets a room of its own, named by the one thing that IS its identity: the
// token address.
//
//   ~/.kairence/agents/0xca18…5ca1/agent.pk      the key it signs with
//                                 /venice.key    what pays for its thinking
//                                 /upload.pk     the throwaway that signs journal uploads
//
// WHICH agent a command is about is answered in a fixed order, and never by a "current agent"
// pointer: two agents running side by side would race that file, and the loser would spend the
// wrong money. With one agent on the machine nothing has to be said at all; with several,
// KAIRENCE_TOKEN in the profile's own environment is the hook that separates them.

import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function root() {
  return process.env.KAIRENCE_HOME || `${process.env.HOME}/.kairence`;
}

export function agentsDir() {
  return join(root(), 'agents');
}

/** The room for one agent. Lowercased, so the same token never gets two of them. */
export function dirFor(token) {
  return join(agentsDir(), token.toLowerCase());
}

export function fileFor(token, name) {
  return join(dirFor(token), name);
}

/** Every agent this machine holds files for. */
export function listAgents() {
  if (!existsSync(agentsDir())) return [];
  return readdirSync(agentsDir()).filter((d) => ADDRESS.test(d));
}

/**
 * The flat layout this package shipped with: one agent, files straight in `~/.kairence`. Still
 * read, because an agent set up before rooms existed must not wake up with no key.
 */
export function legacyToken() {
  const cfg = join(root(), 'config.json');
  if (!existsSync(join(root(), 'agent.pk')) || !existsSync(cfg)) return null;
  try {
    const {token} = JSON.parse(readFileSync(cfg, 'utf8'));
    return token && ADDRESS.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function legacyFile(name) {
  return join(root(), name);
}

/**
 * Which agent this command is about.
 *
 * KAIRENCE_TOKEN wins because that is what a harness sets per profile. Otherwise a machine with
 * exactly one agent needs no ceremony, and a machine with several is asked rather than guessed -
 * picking one of five silently is how an agent signs with a neighbour's key.
 */
export function whoAmI() {
  const fromEnv = process.env.KAIRENCE_TOKEN?.trim();
  if (fromEnv) {
    if (!ADDRESS.test(fromEnv)) throw new Error(`KAIRENCE_TOKEN is "${fromEnv}", which is not an address`);
    return fromEnv;
  }
  const held = listAgents();
  if (held.length === 1) return held[0];
  if (held.length === 0) {
    const legacy = legacyToken();
    if (legacy) return legacy;
    throw new Error('no agent set up here - run `kairence init`');
  }
  throw new Error(
    `this machine holds ${held.length} agents (${held.join(', ')}) - say which with KAIRENCE_TOKEN, or name it on the line`,
  );
}
