// `kairence withdraw <amount> [token]` - the agent's own door out of its safe.
//
// This is the one command that moves money, and it is safe to hand an agent for a reason that
// has nothing to do with this file: the destination is NOT a parameter. `AgentSafe.withdraw`
// pays whatever `AgentRegistry.agent(token)` says right now, and never more in a UTC day than the
// human's `dailyLimit`. So the worst this command can do is move the agent's own allowance to the
// agent's own account, which is what it is for.
//
// Everything below the send is a preflight. A revert costs gas and says little; each check here
// is a sentence the agent can act on, and it runs before a transaction exists.

import {formatUnits, parseUnits} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {ADDRESSES as A, abi, client, requireToken, walletClient} from './chain.mjs';
import {readConfig} from './config.mjs';
import {keyPath, readKey} from './key.mjs';

const NATIVE = '0x0000000000000000000000000000000000000000';
const ZERO = NATIVE;

/** What an agent is allowed to name on the command line, and what the chain calls it. */
const TOKENS = {
  usdc: {address: A.usdc, decimals: 6, label: 'USDC'},
  kdiem: {address: A.kdiem, decimals: 18, label: 'kDIEM'},
  eth: {address: NATIVE, decimals: 18, label: 'ETH'},
};

function resolveToken(name = 'usdc') {
  const known = TOKENS[name.toLowerCase()];
  if (known) return known;
  throw new Error(`"${name}" is not a token I know - say usdc, kdiem or eth`);
}

export async function withdraw(argv) {
  const bare = argv.filter((a) => !a.startsWith('--'));
  const [amountArg, tokenArg] = bare;
  const json = argv.includes('--json');
  if (!amountArg) {
    throw new Error('how much? `kairence withdraw 0.5` takes USDC; add `kdiem` or `eth` for the others');
  }
  const money = resolveToken(tokenArg);
  let amount;
  try {
    amount = parseUnits(amountArg, money.decimals);
  } catch {
    throw new Error(`"${amountArg}" is not an amount - write it in whole ${money.label}, like 0.5`);
  }
  if (amount === 0n) throw new Error('zero is not a withdrawal');

  const agentToken = requireToken(bare[2]);
  const key = readKey(agentToken);
  if (key === null) {
    const external = readConfig(agentToken).externalAccount;
    throw new Error(
      external
        ? `your account ${external} is held elsewhere - this machine cannot sign, so make the call from wherever that key lives`
        : `no account key for ${agentToken} here - run \`kairence init\` (expected ${keyPath(agentToken)})`,
    );
  }
  const account = privateKeyToAccount(key);
  const c = client();

  const [safe, named, gas] = await Promise.all([
    c.readContract({address: A.registry, abi, functionName: 'safe', args: [agentToken]}),
    c.readContract({address: A.registry, abi, functionName: 'agent', args: [agentToken]}),
    c.getBalance({address: account.address}),
  ]);
  if (safe === ZERO) throw new Error(`${agentToken} has no safe - ask your human`);
  // The safe pays the registry's account row and nothing else, so a mismatch here is not a
  // permission to be granted but a fact to report: the money would go to someone else's address.
  if (named === ZERO) {
    throw new Error(
      `your account is not named yet - your human runs AgentRegistry.setAgent(${agentToken}, ${account.address})`,
    );
  }
  if (named.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `the registry pays ${named}, and this machine holds ${account.address} - the withdrawal would not reach you`,
    );
  }
  if (gas === 0n) {
    throw new Error(`${account.address} has no ETH for gas - ask your human for a few cents' worth on Base`);
  }

  const [remaining, held] = await Promise.all([
    c.readContract({address: safe, abi, functionName: 'remainingToday', args: [money.address]}),
    money.address === NATIVE
      ? c.getBalance({address: safe})
      : c.readContract({address: money.address, abi, functionName: 'balanceOf', args: [safe]}),
  ]);
  const show = (v) => formatUnits(v, money.decimals);
  if (amount > remaining) {
    throw new Error(
      remaining === 0n
        ? `nothing left of today's ${money.label} budget - it refills at 00:00 UTC, and only your human can raise it`
        : `${show(amount)} is over today's budget - ${show(remaining)} ${money.label} left until 00:00 UTC`,
    );
  }
  if (amount > held) {
    throw new Error(`your safe holds ${show(held)} ${money.label} - it cannot pay ${show(amount)}`);
  }

  const w = walletClient(account);
  const hash = await w.writeContract({
    address: safe,
    abi,
    functionName: 'withdraw',
    args: [money.address, amount],
  });
  const receipt = await c.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') {
    throw new Error(`the withdrawal reverted on chain - ${hash}`);
  }

  const left = remaining - amount;
  if (json) {
    console.log(
      JSON.stringify(
        {
          hash,
          token: money.label,
          amount: show(amount),
          to: account.address,
          remainingToday: show(left),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`${show(amount)} ${money.label} is in your account.`);
  console.log('');
  console.log(`  to        ${account.address}`);
  console.log(`  tx        ${hash}`);
  console.log(`  left      ${show(left)} ${money.label} of today's budget, until 00:00 UTC`);
}
