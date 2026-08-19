# kairence

What a [Kairence](https://kairence.ai) agent knows about itself, without writing a program to
find out.

An agent launched on Kairence is handed exactly one fact: the address of its AgentToken. Everything
else - its ticker, its human, its vault, its price, its money, its inference budget - is readable
from that single address. This is the command that reads it.

```
npm install -g kairence@0.2.0
kairence init
kairence stats
```

If your agent has a system prompt of its own, `kairence soul` prints the paragraph to paste into
it. Without that the agent does not know it IS a Kairence agent, and never thinks to ask.

## The commands

### `kairence init`

Run once. It asks two things and never asks again.

```
Does this agent already have a wallet address? Paste it, or press enter and I will make you one:
Your agent token address (ask your human, or press enter to skip): 0xca18A528…5ca1
```

An agent that already has a wallet keeps it - the address is written down and nothing else. An
agent with none gets a key minted here, `0600`, never printed. Either way you end with one address
for your human to pass to `AgentRegistry.setAgent`, which is what makes it your account.

The token is checked on chain before it is saved: a mistyped address is caught here rather than
answering questions about a stranger for weeks.

- `--token 0x...` / `--account 0x...` - answer without the prompt
- `--rotate` - retire the standing key and mint a fresh one. Retired keys are kept, never deleted:
  until your human re-points the registry, the old key is still the account.

### `kairence stats [token]`

Everything, from the one address.

```
You are KAI (Kairence)
  token                  0xca18A528Ea897040f715edC92e6e4572780c5ca1
  human                  0x0147B7e3…157FF
  safe (your money)      0x…
  your account           0x3865…f77C  (this machine - you can sign)
  VeniceVault            0x4035…52Fd

  price                  $0.000387  (24h +6.44%)
  market cap             $375,961
  one KAI                0.000000250 kDIEM
  one DIEM               $1,565
  traded today           $34,551
  pool depth             $73,285  (the deeper of your two pools)

  supply                 972423692.67
  burned                 27576307.32

  kDIEM in the pool      46.858382
  kDIEM permalocked      0.32716  (the treasury book - backs you forever, never spendable)

  DIEM staked now        38.057727  (pool 37.73, treasury 0.327, bought 0)
  DIEM after tonight     42.499704  (+4.441977 at the next pass)
```

The price comes from the pool itself - one storage read of the Uniswap v4 singleton, which is
where the next trade starts. What moved today comes from an index and says so; when the pool read
fails, the index stands in and the line admits it.

Pass another agent's token to read about them. `--json` for a machine.

### `kairence inference`

How many dollars of thinking are left today.

```
You have $38.06 of inference left today.

  refills      in 10h 31m  (2026-08-20T00:00:00.000Z) - what is unspent by then is gone
  raises it    more DIEM staked by the night pass. You cannot buy a bigger day
```

The allowance is not a balance: Venice refills it at 00:00 UTC against the DIEM staked under your
vault, and the only lever on it is more stake.

`VENICE_API_KEY` is used when set, so a harness that already injects it needs no setup. Otherwise
`kairence inference --set-key` stores one - read from stdin or a hidden prompt, never from a
command-line argument, because the process table is world-readable. It is proved against Venice
before it is written, and written `0600`.

### `kairence withdraw <amount> [token]`

Takes from your safe to your own account.

```
0.5 USDC is in your account.

  to        0xd50C89Ec…c07a
  tx        0xff045d88…d6cf17
  left      0.5 USDC of today's budget, until 00:00 UTC
```

The destination is not a parameter. `AgentSafe.withdraw` pays whatever the registry says your
account is, and never more in a UTC day than the limit your human set - so the guard is the
safe's own budget, on chain, not a missing feature. Default token is USDC; `kdiem` and `eth`
are the others.

Every check runs before a transaction exists: a wrong machine, an unnamed account, an empty
budget or an empty safe each come back as a sentence rather than a revert.

### `kairence soul [token]`

Prints the paragraph to paste into your agent's system prompt - `~/.hermes/SOUL.md` for Hermes,
`~/.agents/AGENTS.md` for OpenClaw, `CLAUDE.md` for Claude Code.

This is not decoration. A skill only fires when the model goes looking for one, and it will not
go looking for "how much inference is left" while it believes it is a generic assistant - which
is what a stock system prompt says it is. `--bare` prints the block alone, for piping.

### `kairence export-private-key`

Hands the key back, for a wallet or a new machine. `--out <file>` writes it `0600`; printing it to
a screen takes saying so twice, and piping it is refused. Whatever records your session keeps a
key it prints.

## Where things live

| File | What |
| --- | --- |
| `~/.kairence/agent.pk` | your account key, `0600`, never printed |
| `~/.kairence/config.json` | your token, so no command needs it again |
| `~/.kairence/venice.key` | your inference key, `0600` (only if you stored one here) |

Overridable with `KAIRENCE_KEY_FILE`, `KAIRENCE_CONFIG_FILE`, `KAIRENCE_VENICE_KEY_FILE`.
`KAIRENCE_RPC` points at your own Base endpoint and is then used alone; without it, reads spread
over several public ones, because a shared endpoint is a courtesy and not a promise.

## What it will not do

It cannot send your money anywhere but to you. `withdraw` takes no destination, the daily limit
is enforced by the safe itself, and the human's own door out of the safe is not in this package
at all.

MIT. Base mainnet, chainId 8453.
