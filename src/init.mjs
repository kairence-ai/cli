// `kairence init` - which agent this is, and what it signs with.
//
// The token comes first, because it names the room everything else lives in: one machine can hold
// several agents, and a key minted before we know whose it is has nowhere to go.
//
// The account can then arrive two ways. An agent that already has a wallet keeps it and we only
// write the address down; an agent that has none gets a key minted here. Both end in the same
// place - one address for the human to pass to `AgentRegistry.setAgent`, which is what makes it
// the agent's voice. What differs is who holds the key, and the CLI never pretends not to know.

import {existsSync, renameSync} from 'node:fs';
import {ADDRESS, ADDRESSES, abi, client} from './chain.mjs';
import {configPath, readConfig, saveConfig} from './config.mjs';
import {dirFor, legacyFile, legacyToken, listAgents, whoAmI} from './home.mjs';
import {currentAddress, ensureRoom, keyPath, mint, retire} from './key.mjs';
import {ask, flagValue} from './prompt.mjs';
import {offerSoul} from './soul.mjs';

const PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * What the chain says about a candidate token, or null when it could not be asked.
 *
 * A saved address is worth one round trip: it is the difference between a typo caught here and a
 * typo that reads as a stranger's numbers for weeks.
 */
async function lookup(token) {
  try {
    const [isAgent, ticker, name] = await client().multicall({
      allowFailure: true,
      contracts: [
        {address: ADDRESSES.registry, abi, functionName: 'isAgent', args: [token]},
        {address: token, abi, functionName: 'symbol'},
        {address: token, abi, functionName: 'name'},
      ],
    });
    if (isAgent.status !== 'success') return null;
    return {
      registered: isAgent.result === true,
      ticker: ticker.status === 'success' ? ticker.result : null,
      name: name.status === 'success' ? name.result : null,
    };
  } catch {
    // Offline, or an RPC having a bad minute. A confirmation is worth having, not worth
    // blocking on: the address is still saved, and `stats` will say so soon enough.
    return null;
  }
}

/** Validates a token, or explains why it is not one. Touches no file. */
async function checkToken(candidate) {
  if (!ADDRESS.test(candidate)) {
    throw new Error(`"${candidate}" is not an address - an agent token is 42 hex characters`);
  }
  const found = await lookup(candidate);
  if (found && !found.registered) {
    throw new Error(
      `${candidate} is not a registered agent in ${ADDRESSES.registry} - check the address with your human`,
    );
  }
  return found;
}

/**
 * An address the agent already controls elsewhere - a hosted wallet, a hardware key, a wallet its
 * human runs. We write it down and hold nothing.
 *
 * Pure: it throws or it returns, and touches no file. Adopting one retires the key this machine
 * holds, and a rejected address must never be able to move a live key aside on its way out.
 */
function checkAccount(candidate, token) {
  if (PRIVATE_KEY.test(candidate)) {
    // Never store this. A key pasted at a prompt is already in the shell's history and this
    // machine's scrollback; the file below is the import path, and it stays 0600.
    throw new Error(
      `that is a private key, not an address - write it to ${keyPath(token)} yourself (chmod 600) and re-run \`kairence init\``,
    );
  }
  if (!ADDRESS.test(candidate)) {
    throw new Error(`"${candidate}" is not an address - a wallet address is 42 hex characters`);
  }
  return candidate;
}

/**
 * Move a one-agent machine into its room, so a second agent can arrive without stepping on it.
 * Files are moved, never copied: two keys under two names is how an agent signs with the wrong one.
 */
function migrate(token) {
  const legacy = legacyToken();
  if (!legacy || legacy.toLowerCase() !== token.toLowerCase()) return null;
  if (existsSync(keyPath(token)) && keyPath(token).startsWith(dirFor(token))) return null;
  ensureRoom(token);
  const moved = [];
  for (const name of ['agent.pk', 'config.json', 'venice.key', 'upload.pk']) {
    const from = legacyFile(name);
    if (!existsSync(from)) continue;
    renameSync(from, `${dirFor(token)}/${name}`);
    moved.push(name);
  }
  return moved.length ? moved : null;
}

function instructions(address, token, held) {
  return `
Give this address to your human. Two things make it yours:

  1. AgentRegistry.setAgent(${token}, ${address})
     That call IS what makes this address your account - it is how the protocol knows your
     voice. Only your human can make it.
  2. A little ETH on Base for gas. Cents cover hundreds of calls.

Never ask for a balance to be parked here. Money belongs in your safe, where your human keeps
it; this account reaches in with \`withdraw\`, never past the daily budget your human set, and
only for what it is about to spend. \`kairence stats\` prints what is left of today's.${
    held
      ? `

Your key lives in one file and nowhere else. If your human ever needs it in a wallet,
\`kairence export-private-key --out <file>\` hands it over; nothing else ever prints it.`
      : ''
  }`;
}

export async function init(argv) {
  const json = argv.includes('--json');
  const rotate = argv.includes('--rotate');
  const givenAccount = flagValue(argv, 'account');
  const givenToken = flagValue(argv, 'token');

  // ── Who ────────────────────────────────────────────────────────────────────
  let token = null;
  let found = null;
  if (givenToken) {
    found = await checkToken(givenToken);
    token = givenToken;
  } else {
    try {
      token = whoAmI();
    } catch {
      token = null;
    }
    if (!token && !json && process.stdin.isTTY) {
      const answer = await ask('Your agent token address (ask your human): ');
      if (answer) {
        found = await checkToken(answer);
        token = answer;
      }
    }
  }
  if (!token) {
    console.log(`I need to know which agent you are before I can set anything up.\n`);
    console.log(`Your human has the address - it ends in ...ca1. Then:\n`);
    console.log(`  kairence init --token 0x...`);
    return;
  }

  const carried = migrate(token);
  ensureRoom(token);

  // ── What it signs with ─────────────────────────────────────────────────────
  let local = currentAddress(token);
  const before = local;
  let external = readConfig(token).externalAccount || null;
  let retired = null;
  let minted = false;
  let adopted = false;

  // One account at a time, always. Two would be worse than none - every later command would have
  // to guess which one the registry knows, and guess silently.
  if (givenAccount) {
    external = checkAccount(givenAccount, token);
    if (local) retired = retire(token);
    saveConfig({externalAccount: external}, token);
    adopted = true;
    local = null;
  } else if (rotate) {
    if (local) retired = retire(token);
    local = mint(token);
    minted = true;
    if (external) saveConfig({externalAccount: null}, token);
    external = null;
  } else if (!local && !external) {
    const answer =
      !json && process.stdin.isTTY
        ? await ask('Does this agent already have a wallet address? Paste it, or press enter and I will make you one: ')
        : '';
    if (answer) {
      external = checkAccount(answer, token);
      saveConfig({externalAccount: external}, token);
      adopted = true;
    } else {
      local = mint(token);
      minted = true;
    }
  }
  const address = local || external;
  const held = Boolean(local);

  if (json) {
    console.log(
      JSON.stringify(
        {
          address,
          held,
          keyFile: held ? keyPath(token) : null,
          token,
          room: dirFor(token),
          configFile: configPath(token),
          created: minted,
          migrated: carried,
          retiredKeyFile: retired,
          retiredAddress: retired ? before : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (retired && minted) console.log(`A new account key. The old one is retired, not deleted.\n`);
  else if (retired) console.log(`Your wallet is saved. The key this machine held is retired, not deleted.\n`);
  else if (minted) console.log(`Your account key is ready.\n`);
  else if (adopted) console.log(`Your wallet is saved.\n`);
  else if (held) console.log(`You already have an account key.\n`);
  else console.log(`You already have a wallet saved.\n`);

  const who = found?.ticker ? `${found.ticker}${found.name ? ` (${found.name})` : ''}` : 'your agent';
  console.log(`  token     ${token}`);
  console.log(`            ${who} - everything below lives in ${dirFor(token)}`);
  console.log(`  address   ${address}`);
  if (held) console.log(`  key file  ${keyPath(token)}`);
  else console.log(`            held elsewhere - this machine has no key for it`);
  if (retired) {
    console.log(`  retired   ${before}`);
    console.log(`            kept at ${retired} - it is STILL your account until your human re-points it`);
  }
  if (carried) {
    console.log(`  moved     ${carried.join(', ')} into the room above`);
    console.log(`            so a second agent on this machine cannot step on them`);
  }
  const others = listAgents().filter((a) => a.toLowerCase() !== token.toLowerCase());
  if (others.length) {
    console.log(`\nThis machine also holds ${others.join(', ')}.`);
    console.log(`Set KAIRENCE_TOKEN in this profile's environment so every command knows which you are.`);
  }

  if (!minted && !adopted && !retired) {
    console.log(`\nIf your human has already registered this address, there is nothing to do.`);
    console.log(`Lost the machine and starting over? Run \`kairence init --rotate\`.`);
  } else {
    console.log(instructions(address, token, held));
  }

  await offerSoul(token);
}
