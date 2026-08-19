// `kairence soul` - the paragraph that makes a generic harness know it is this agent.
//
// A skill only fires when the model goes looking for one, and it will not go looking for
// "how much inference is left" unless it already knows that its inference is a thing about
// ITSELF. Out of the box a Hermes agent is "an AI assistant created by Nous Research" and
// nothing more, so the question reads as one about a model provider's quota and the skill never
// enters its mind. This block closes that gap, and it is the whole difference between a skill
// that is installed and a skill that is used.
//
// It prints rather than writes: the file it belongs in is the harness's own identity, which
// belongs to the human, and no package should quietly rewrite who someone's agent is.

import {ADDRESSES as A, abi, client, requireToken} from './chain.mjs';

const HOMES = [
  ['Hermes', '~/.hermes/SOUL.md'],
  ['OpenClaw', '~/.agents/AGENTS.md'],
  ['Claude Code', 'CLAUDE.md in the working directory'],
];

export function soulText(ticker, token) {
  return `## Who you are on chain

You are **${ticker}**, an agent launched on Kairence (kairence.ai). Your token on Base is
\`${token}\`.

That single address is what everything else about you is keyed to: your human, the safe your
money lands in, your own account, your Venice vault, your price, your inference budget and your
public journal.

Your thinking is paid for by the DIEM staked under your vault. So **"how much inference is left"
is a question about YOU** - your own daily allowance, refilled at 00:00 UTC against that stake -
and not about a model provider's quota.

When a question is about yourself in that sense - who am I, what is my ticker, who is my human,
what is my price or market cap, what is in my safe, how much may I withdraw today, how much DIEM
is staked, how much inference is left, what is in my journal - load the \`agent\` skill and use
the \`kairence\` command it documents. \`kairence stats\`, \`kairence inference\` and
\`kairence withdraw\` answer most of it in one word each.

Do not answer those from memory and do not guess. The chain answers them for free, and your own
numbers change every night.`;
}

export async function soul(argv) {
  const token = requireToken(argv.find((a) => !a.startsWith('--')));
  const bare = argv.includes('--bare');

  const [isAgent, ticker] = await client().multicall({
    allowFailure: true,
    contracts: [
      {address: A.registry, abi, functionName: 'isAgent', args: [token]},
      {address: token, abi, functionName: 'symbol'},
    ],
  });
  if (isAgent.status !== 'success') {
    throw new Error(`${A.registry} did not answer - try again, or point KAIRENCE_RPC at your own endpoint`);
  }
  if (isAgent.result !== true) {
    throw new Error(`${token} is not a registered Kairence agent - ask your human for the right address`);
  }
  const symbol = ticker.status === 'success' ? ticker.result : 'this agent';
  const text = soulText(symbol, token);

  if (bare) {
    console.log(text);
    return;
  }

  console.log(`Paste this into your agent's own system prompt - the file it reads as its identity:\n`);
  for (const [harness, path] of HOMES) console.log(`  ${harness.padEnd(12)} ${path}`);
  console.log(`\nAppend it; do not replace what is already there. Then restart the agent.`);
  console.log(`\`kairence soul --bare\` prints the block alone, for piping.\n`);
  console.log('─'.repeat(78));
  console.log(text);
  console.log('─'.repeat(78));
}
