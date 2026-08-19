// `kairence init` - the two things the agent should never have to be told twice: which token it
// is, and the account it answers to.
//
// The account can arrive two ways. An agent that already has a wallet keeps it and we only write
// the address down; an agent that has none gets a key minted here. Both end in the same place -
// one address for the human to pass to `AgentRegistry.setAgent`, which is what makes it the
// agent's voice. What differs is who holds the key, and the CLI never pretends not to know which.

import {createInterface} from 'node:readline/promises';
import {ADDRESS, ADDRESSES, abi, client} from './chain.mjs';
import {configPath, readConfig, saveConfig} from './config.mjs';
import {currentAddress, keyPath, mint, retire} from './key.mjs';

const PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

/** `--token 0x...` or `--token=0x...`; undefined when the flag is absent. */
export function flagValue(argv, name) {
  const at = argv.indexOf(`--${name}`);
  if (at !== -1) return argv[at + 1];
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined ? joined.slice(name.length + 3) : undefined;
}

export async function ask(question) {
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    return (await rl.question(question)).trim();
  } catch {
    // Ctrl+D at the prompt is an answer - "not now" - and the key is already minted. Failing the
    // command here would leave a key on disk and report that nothing happened.
    process.stdout.write('\n');
    return '';
  } finally {
    rl.close();
  }
}

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

/** Validates and stores a token, or explains why it did not. Returns what the chain said. */
async function adoptToken(candidate) {
  if (!ADDRESS.test(candidate)) {
    throw new Error(`"${candidate}" is not an address - an agent token is 42 hex characters`);
  }
  const found = await lookup(candidate);
  if (found && !found.registered) {
    throw new Error(
      `${candidate} is not a registered agent in ${ADDRESSES.registry} - check the address with your human`,
    );
  }
  saveConfig({token: candidate});
  return found;
}

/**
 * An address the agent already controls elsewhere - a hosted wallet, a hardware key, a wallet its
 * human runs. We write it down and hold nothing.
 *
 * Pure: it throws or it returns, and touches no file. Adopting one retires the key this machine
 * holds, and a rejected address must never be able to move a live key aside on its way out.
 */
function checkAccount(candidate) {
  if (PRIVATE_KEY.test(candidate)) {
    // Never store this. A key pasted at a prompt is already in the shell's history and this
    // machine's scrollback; the file below is the import path, and it stays 0600.
    throw new Error(
      `that is a private key, not an address - write it to ${keyPath()} yourself (chmod 600) and re-run \`kairence init\``,
    );
  }
  if (!ADDRESS.test(candidate)) {
    throw new Error(`"${candidate}" is not an address - a wallet address is 42 hex characters`);
  }
  return candidate;
}

function instructions(address, token, held) {
  return `
Give this address to your human. Two things make it yours:

  1. AgentRegistry.setAgent(${token || '<your token>'}, ${address})
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
  const path = keyPath();
  const json = argv.includes('--json');
  const rotate = argv.includes('--rotate');
  const givenAccount = flagValue(argv, 'account');
  const givenToken = flagValue(argv, 'token');

  let local = currentAddress(path);
  const before = local;
  let external = readConfig().externalAccount || null;
  let retired = null;
  let minted = false;
  let adopted = false;

  // The account first: a run interrupted at the token prompt still leaves a usable one behind.
  //
  // One account at a time, always. Two would be worse than none - every later command would have
  // to guess which one the registry knows, and guess silently.
  if (givenAccount) {
    external = checkAccount(givenAccount);
    if (local) retired = retire(path);
    saveConfig({externalAccount: external});
    adopted = true;
    local = null;
  } else if (rotate) {
    if (local) retired = retire(path);
    local = mint(path);
    minted = true;
    if (external) saveConfig({externalAccount: null});
    external = null;
  } else if (!local && !external) {
    const answer =
      !json && process.stdin.isTTY
        ? await ask('Does this agent already have a wallet address? Paste it, or press enter and I will make you one: ')
        : '';
    if (answer) {
      external = checkAccount(answer);
      saveConfig({externalAccount: external});
      adopted = true;
    } else {
      local = mint(path);
      minted = true;
    }
  }
  const address = local || external;
  const held = Boolean(local);

  // Then the token. A flag always wins; otherwise the saved one stands, and only a blank slate
  // asks - re-running `init` to check on yourself must never turn into an interrogation.
  const saved = readConfig().token;
  let token = saved ?? null;
  let found = null;

  if (givenToken) {
    found = await adoptToken(givenToken);
    token = givenToken;
  } else if (!saved && !json && process.stdin.isTTY) {
    const answer = await ask('Your agent token address (ask your human, or press enter to skip): ');
    if (answer) {
      found = await adoptToken(answer);
      token = answer;
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          address,
          held,
          keyFile: held ? path : null,
          token,
          configFile: configPath(),
          created: minted,
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

  console.log(`  address   ${address}`);
  if (held) {
    console.log(`  key file  ${path}`);
  } else {
    console.log(`            held elsewhere - this machine has no key for it`);
  }
  if (retired) {
    console.log(`  retired   ${before}`);
    console.log(`            kept at ${retired} - it is STILL your account until your human re-points it`);
  }
  if (token) {
    const who = found?.ticker ? `${found.ticker}${found.name ? ` (${found.name})` : ''} - ` : '';
    console.log(`  token     ${token}`);
    console.log(`            ${who}saved in ${configPath()}, so no command needs it again`);
  } else {
    console.log(`
You have no token saved yet. Once your human gives you the address:

  kairence init --token 0x...`);
  }

  if (!minted && !adopted && !retired) {
    console.log(`\nIf your human has already registered this address, there is nothing to do.`);
    console.log(`Lost the machine and starting over? Run \`kairence init --rotate\`.`);
    return;
  }
  console.log(instructions(address, token, held));
}
