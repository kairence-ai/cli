#!/usr/bin/env node
// The Kairence CLI: what an agent knows about itself, without writing a program to find out.
//
// Everything here READS, or writes the agent's own journal. It moves no money: the agent's safe
// is the human's custody, the agent's own reach into it is a daily budget the human sets, and a
// tool that could empty it would quietly reverse both.

import {exportPrivateKey} from '../src/exportKey.mjs';
import {inference} from '../src/inference.mjs';
import {init} from '../src/init.mjs';
import {stats} from '../src/stats.mjs';

const USAGE = `kairence - what a Kairence agent knows about itself

Usage:
  kairence init [--token 0x...]      remember which agent you are, and settle your account
  kairence stats [token] [--json]    identity, money, staking, burns and buyback pots
  kairence inference [--json]        dollars of thinking left today, and when it refills
  kairence export-private-key        hand your key back, for a wallet or a new machine

Run \`init\` once. Every other command then knows your token without being told.

Options:
  --json                             machine-readable output
  --token 0x...                      (init) the agent token you are; asked for when absent
  --account 0x...                    (init) a wallet you already have; skips minting a key
  --rotate                           (init) retire the standing key and mint a fresh one
  --set-key                          (inference) store your Venice key, read from stdin only
  --out <file>                       (export-private-key) write it 0600 instead of printing
  --yes                              (export-private-key) print it without being asked twice
  --help                             this text

Environment:
  KAIRENCE_RPC                       your own Base endpoint, used alone (default: four public ones)
  KAIRENCE_KEY_FILE                  where your account key lives (default: ~/.kairence/agent.pk)
  KAIRENCE_CONFIG_FILE               where your token is saved (default: ~/.kairence/config.json)
  KAIRENCE_TOKEN                     a token that overrides the saved one, for one command
  VENICE_API_KEY                     your inference key; used ahead of the stored one
  KAIRENCE_VENICE_KEY_FILE           where it is stored (default: ~/.kairence/venice.key)
`;

const [command, ...argv] = process.argv.slice(2);

const commands = {init, stats, inference, 'export-private-key': exportPrivateKey};

async function main() {
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const run = commands[command];
  if (!run) {
    throw new Error(`no such command: ${command}. Run \`kairence --help\`.`);
  }
  await run(argv);
}

main().catch((error) => {
  // One line, no stack: the caller is an agent deciding what to say next, not a debugger.
  console.error(`kairence: ${error.shortMessage || error.message}`);
  process.exit(1);
});
