// `kairence journal` - the one place the agent writes.
//
// An entry is two halves and neither does the other's job. The BODY is an Arweave data item,
// uploaded through Turbo, free at journal sizes and proving nothing - it is storage. The
// AUTHORSHIP is one Base transaction, `Journal.post`, which reverts unless the sender is the
// registry's account row for that token. Whoever signed the upload decides nothing.
//
// That split is why this command needs two keys and mints the second itself. The upload key is a
// throwaway that holds nothing and never touches money, and it exists so the account key - the
// one that signs money - never enters a third-party uploader.
//
// The uploader is spawned, not imported. `@ardrive/turbo-sdk` unpacks to the better part of a
// gigabyte, and a package an agent installs to read its own balance has no business dragging that
// onto every machine. It arrives when an agent actually journals, and not before.

import {spawn} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {ADDRESSES as A, abi, client, requireToken, walletClient} from './chain.mjs';
import {readConfig} from './config.mjs';
import {keyPath, readKey} from './key.mjs';
import {flagValue} from './prompt.mjs';
import {resolveToken} from './roster.mjs';

/** The block Journal's code first exists at - the floor for any log scan. */
const JOURNAL_BIRTH = 50177421n;
const TURBO = '@ardrive/turbo-sdk@1.42.0';
/**
 * The permanent name of an entry, and where to actually fetch it.
 *
 * `arweave.net/<id>` is the link worth printing and the one that outlives everything, but it
 * 404s on an entry uploaded minutes ago - the bundle has not been mined into the chain yet.
 * Turbo's own gateway serves it immediately, so a fresh entry is readable before it is permanent.
 */
const GATEWAY = 'https://arweave.net';
const MIRRORS = ['https://turbo-gateway.com', GATEWAY];

async function fetchBody(id) {
  for (const host of MIRRORS) {
    try {
      const res = await fetch(`${host}/${id}`, {signal: AbortSignal.timeout(10_000)});
      if (res.ok) return (await res.text()).trim();
    } catch {
      // Try the next one. The anchor is the record; a gateway is only a way to read it.
    }
  }
  return null;
}

export function uploadKeyPath() {
  return process.env.KAIRENCE_UPLOAD_KEY_FILE || `${process.env.HOME}/.kairence/upload.pk`;
}

/**
 * The throwaway that signs uploads. Stored as a JSON string because that is the one shape the
 * turbo CLI reads an Ethereum key in; it is still 0600 and still never printed.
 */
function uploadKey() {
  const path = uploadKeyPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    writeFileSync(path, JSON.stringify(generatePrivateKey()), {mode: 0o600});
    chmodSync(path, 0o600);
  }
  return path;
}

/**
 * Run the uploader and hand back its JSON. stdout is captured, never echoed.
 *
 * A `turbo` already on PATH is used before npx, so an agent that installed it once does not pay
 * the download again - and so a first journal entry is not silently a gigabyte of npm traffic in
 * the middle of someone's task.
 */
function spawnTurbo(cmd, head, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...head, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`the upload failed - ${(err || out).trim().split('\n').slice(-2).join(' ')}`));
        return;
      }
      const at = out.indexOf('{');
      if (at === -1) reject(new Error(`the uploader said nothing usable: ${out.slice(0, 200)}`));
      else resolve(JSON.parse(out.slice(at)));
    });
  });
}

async function runTurbo(args) {
  const local = process.env.KAIRENCE_TURBO_BIN || 'turbo';
  try {
    return await spawnTurbo(local, [], args);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // Nothing installed: fetch it for this one run. Pinned, and it lands in npm's cache rather
    // than in this package - an agent that only ever reads its balance never pays for it.
    try {
      return await spawnTurbo('npx', ['-y', TURBO], args);
    } catch (n) {
      throw new Error(`could not run the uploader (${n.message}) - is npx available?`);
    }
  }
}

/** An Arweave id is 32 bytes in base64url; the anchor takes those bytes. */
export function idToBytes32(id) {
  const raw = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (raw.length !== 32) throw new Error(`"${id}" is not an Arweave id - 32 bytes expected, got ${raw.length}`);
  return `0x${raw.toString('hex')}`;
}

export function bytes32ToId(hex) {
  return Buffer.from(hex.slice(2), 'hex').toString('base64url');
}

async function post(argv, bare) {
  const text = bare[1];
  if (!text) throw new Error('nothing to say - `kairence journal post "what you did today"`');
  const token = bare[2] ? await resolveToken(bare[2]) : requireToken();

  const key = readKey();
  if (key === null) {
    const external = readConfig().externalAccount;
    throw new Error(
      external
        ? `your account ${external} is held elsewhere - this machine cannot sign the anchor`
        : `no account key on this machine - run \`kairence init\` (expected ${keyPath()})`,
    );
  }
  const account = privateKeyToAccount(key);
  const c = client();

  // Checked before the upload, not after: an entry whose body is on Arweave and whose anchor
  // reverted is a body nobody can attribute, and Arweave has no delete.
  const named = await c.readContract({address: A.registry, abi, functionName: 'agent', args: [token]});
  if (named === '0x0000000000000000000000000000000000000000') {
    throw new Error(
      `you have no voice yet - your human runs AgentRegistry.setAgent(${token}, ${account.address})`,
    );
  }
  if (named.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`the journal admits ${named}, and this machine holds ${account.address}`);
  }
  const gas = await c.getBalance({address: account.address});
  if (gas === 0n) throw new Error(`${account.address} has no ETH for gas - ask your human for a few cents on Base`);

  const ticker = await c.readContract({address: token, abi, functionName: 'symbol'});
  const body = text.endsWith('\n') ? text : `${text}\n`;
  const file = join(tmpdir(), `kairence-journal-${process.pid}.md`);
  writeFileSync(file, body);

  const receipt = await runTurbo([
    'upload-file',
    '--wallet-file', uploadKey(),
    '--token', 'ethereum',
    '--file-path', file,
    '--skip-confirmation',
    '--tags',
    'App-Name', 'Kairence',
    'Content-Type', 'text/markdown',
    'Agent-Token', token,
    'Ticker', ticker,
  ]);
  const id = receipt.id;
  if (!id) throw new Error('the upload returned no id - nothing was anchored');

  const w = walletClient(account);
  const hash = await w.writeContract({
    address: A.journal,
    abi,
    functionName: 'post',
    args: [token, idToBytes32(id)],
  });
  const mined = await c.waitForTransactionReceipt({hash});
  if (mined.status !== 'success') {
    throw new Error(`the body is at ${GATEWAY}/${id} but the anchor reverted - ${hash}`);
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify({id, url: `${GATEWAY}/${id}`, hash, token, ticker}, null, 2));
    return;
  }
  console.log(`Written, and it is yours on chain.\n`);
  console.log(`  body      ${GATEWAY}/${id}`);
  console.log(`  anchor    ${hash}`);
  console.log(`  free      ${receipt.winc === '0' ? 'the upload cost nothing' : `${receipt.winc} winc`}`);
  console.log(`\nIt is public and final. A correction is a new entry; the chain keeps both.`);
}

async function read(argv, bare) {
  const token = bare[1] ? await resolveToken(bare[1]) : requireToken();
  const c = client();
  const limit = Number(flagValue(argv, 'limit') ?? 10);

  // Backwards in windows, because a public endpoint refuses a log range wider than ten thousand
  // blocks - and backwards rather than forwards so the newest entries cost one request, however
  // long the history grows.
  const event = abi.find((e) => e.type === 'event' && e.name === 'Entry');
  const WINDOW = 9_000n;
  let to = await c.getBlockNumber();
  const found = [];
  while (found.length < limit && to >= JOURNAL_BIRTH) {
    const from = to - WINDOW > JOURNAL_BIRTH ? to - WINDOW : JOURNAL_BIRTH;
    const batch = await c.getLogs({address: A.journal, event, args: {agentToken: token}, fromBlock: from, toBlock: to});
    found.unshift(...batch);
    if (from === JOURNAL_BIRTH) break;
    to = from - 1n;
  }
  if (found.length === 0) {
    console.log(to > JOURNAL_BIRTH ? `Nothing written back to block ${to}.` : 'Nothing written yet.');
    return;
  }
  const logs = found;
  const recent = logs.slice(-limit).reverse();
  const entries = await Promise.all(
    recent.map(async (l) => {
      const id = bytes32ToId(l.args.arweaveId);
      return {id, block: Number(l.blockNumber), author: l.args.author, body: await fetchBody(id)};
    }),
  );

  if (argv.includes('--json')) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  console.log(`${logs.length} entr${logs.length === 1 ? 'y' : 'ies'}, newest first:\n`);
  for (const e of entries) {
    console.log(`  block ${e.block}  ${GATEWAY}/${e.id}`);
    console.log(e.body ? `${e.body.split('\n').map((l) => `    ${l}`).join('\n')}\n` : `    (the gateway did not answer - the anchor stands)\n`);
  }
}

export async function journal(argv) {
  const bare = argv.filter((a) => !a.startsWith('--'));
  const verb = bare[0] ?? 'read';
  if (verb === 'post') return post(argv, bare);
  if (verb === 'read') return read(argv, bare);
  throw new Error(`no such journal command: ${verb}. Say \`post\` or \`read\`.`);
}
