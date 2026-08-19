// `kairence inference` - how many dollars of thinking are left today.
//
// The allowance is not money in an account: Venice refills it at 00:00 UTC against the DIEM
// staked under the agent's vault, and whatever is unspent at the turn is gone. So the number that
// matters is always "today", and the only lever on it is more stake, which only the night's pass
// can add.
//
// The key that reads this also SPENDS - anyone holding it burns the agent's day. It is never
// printed, never echoed while typed, and never accepted as a command-line argument: the process
// table is world-readable, so a key spelled out in a shell invocation is handed to anything that
// can list processes.

import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {requireToken} from './chain.mjs';
import {fileFor} from './home.mjs';
import {claimOf, hermesProfiles, setEnv, veniceSpendVar} from './harness.mjs';
import {dirname} from 'node:path';

const RATE_LIMITS = 'https://api.venice.ai/api/v1/api_keys/rate_limits';

export function venicePath(token) {
  return process.env.KAIRENCE_VENICE_KEY_FILE || fileFor(token, 'venice.key');
}

/**
 * The environment wins over the file. A harness that already injects the key - Hermes asks the
 * human for it once and passes it through - must not be overridden by a copy of ours that went
 * stale the day the key was rotated.
 */
function veniceKey(token) {
  const fromEnv = process.env.VENICE_API_KEY?.trim();
  if (fromEnv) return {key: fromEnv, where: 'VENICE_API_KEY'};
  const path = venicePath(token);
  if (!existsSync(path)) return null;
  const key = readFileSync(path, 'utf8').trim();
  return key ? {key, where: path} : null;
}

// Built by code point, not written as the bytes themselves: a raw control character in a source
// file is invisible in a diff and is what a copy, a linter or a patch tool silently eats.
const ENTER = ['\r', '\n'];
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = [String.fromCharCode(127), '\b'];

/** Read a secret from a terminal without echoing it - scrollback is forever. */
function askHidden(question) {
  const {stdin, stdout} = process;
  return new Promise((resolve, reject) => {
    // Echo off BEFORE the prompt is printed. The other order leaves a window between the two, and
    // a key pasted into that window is echoed by the tty driver straight into the scrollback -
    // which is the one thing this function exists to prevent.
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdout.write(question);
    let value = '';
    const stop = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ENTER.includes(ch) || ch === CTRL_D) {
          stop();
          resolve(value.trim());
          return;
        }
        if (ch === CTRL_C) {
          stop();
          reject(new Error('cancelled - nothing was saved'));
          return;
        }
        if (BACKSPACE.includes(ch)) value = value.slice(0, -1);
        // Everything below a space is a control key or the head of an escape sequence, and none
        // of it belongs in a key.
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin() {
  let all = '';
  for await (const chunk of process.stdin) all += chunk;
  return all.trim();
}

/** The one call. Returns the parsed body, or throws a sentence about why it could not. */
async function fetchLimits(key) {
  let res;
  try {
    res = await fetch(RATE_LIMITS, {
      headers: {authorization: `Bearer ${key}`},
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`could not reach Venice (${e.message}) - your allowance is unknown, not zero`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Venice refused this key - it was revoked, or it never belonged to your vault');
  }
  if (res.status === 429) {
    throw new Error('Venice is rate-limiting this key - wait a moment, this is not about your allowance');
  }
  if (!res.ok) {
    throw new Error(`Venice answered ${res.status} - your allowance is unknown, not zero`);
  }
  return (await res.json()).data ?? {};
}

/** "9h 12m", the shape of an answer to "how long have I got". */
function until(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'any moment';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function setKey(token) {
  const given = process.stdin.isTTY
    ? await askHidden('Paste your Venice inference key (it will not be shown): ')
    : await readStdin();
  if (!given) throw new Error('nothing to save - pipe the key in, or run this in a terminal');
  if (/\s/.test(given)) {
    throw new Error('that has whitespace in it - a Venice key is one unbroken string');
  }
  // Prove it before storing it. A key saved untested is a key that fails at the moment the agent
  // needed the number, with nothing to say about why.
  const data = await fetchLimits(given);
  const path = venicePath(token);
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path, `${given}\n`, {mode: 0o600});
  chmodSync(path, 0o600);
  // The harness spends through this same key, so setting only ours would leave the agent
  // reporting one budget and burning another - which is exactly the bug this closes.
  const profile = hermesProfiles().find((p) => claimOf(p)?.toLowerCase() === token.toLowerCase());
  if (profile) {
    setEnv(profile.env, 'VENICE_API_KEY', given);
    const spend = veniceSpendVar(profile);
    if (spend) setEnv(profile.env, spend, given);
    console.log(`Also set in the ${profile.name} profile${spend ? `, including what its model spends through` : ''}.`);
  }
  console.log(`Venice accepts it. Saved to ${path} (readable only by you).`);
  console.log(`You have $${Number(data.balances?.DIEM ?? 0).toFixed(2)} of inference left today.`);
}

export async function inference(argv) {
  const token = requireToken(argv.find((a) => !a.startsWith('--')));
  if (argv.includes('--set-key')) return setKey(token);

  const json = argv.includes('--json');
  const found = veniceKey(token);
  if (!found) {
    throw new Error(
      'no Venice key - run `kairence inference --set-key`, or have your human set VENICE_API_KEY',
    );
  }
  const data = await fetchLimits(found.key);

  // `balances.DIEM` IS dollars: every model is priced with identical usd and diem numbers, so one
  // DIEM of allowance buys exactly one dollar of inference. `balances.USD` is a SEPARATE prepaid
  // rail and is never added to it.
  const dollars = Number(data.balances?.DIEM ?? 0);
  const refills = data.nextEpochBegins ?? null;
  const models = Array.isArray(data.rateLimits) ? data.rateLimits.length : 0;
  const rpm = data.rateLimits?.[0]?.rateLimits?.find((r) => r.type === 'RPM')?.amount ?? null;

  if (json) {
    console.log(
      JSON.stringify(
        {
          dollarsLeftToday: dollars,
          accessPermitted: data.accessPermitted ?? null,
          nextEpochBegins: refills,
          refillsIn: refills ? until(refills) : null,
          tier: data.apiTier?.id ?? null,
          prepaidUsd: Number(data.balances?.USD ?? 0),
          models,
          keySource: found.where,
        },
        null,
        2,
      ),
    );
    return;
  }

  const say = (label, value) => console.log(`  ${label.padEnd(12)} ${value}`);

  if (data.accessPermitted === false) {
    // Not a hiccup and not worth a retry loop: something changed about the stake or the key.
    console.log('Venice is not letting you think right now.');
    console.log("\nEither the DIEM staked under your vault fell below Venice's floor, or this key");
    console.log('was revoked. Tell your human in one sentence and stop - retrying will not fix it.');
    return;
  }

  console.log(`You have $${dollars.toFixed(2)} of inference left today.`);
  console.log('');
  if (refills) say('refills', `in ${until(refills)}  (${refills}) - what is unspent by then is gone`);
  say('raises it', 'more DIEM staked by the night pass. You cannot buy a bigger day');
  if (rpm) say('throttle', `${rpm} requests/min across ${models} models - that limit is time, not money`);
  say('key', found.where);
}
