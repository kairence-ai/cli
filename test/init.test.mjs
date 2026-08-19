// `kairence init` - the one command that can destroy something irreplaceable.
//
// A retired key is not a backup. Until the human calls `AgentRegistry.setAgent`, the retired key
// is STILL the agent's account: the address the protocol names, the address holding whatever gas
// was sent to it. So the property under test is narrow and absolute - rotation never loses a key,
// no matter how fast it is run.

import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, it, mock} from 'node:test';
import {privateKeyToAccount} from 'viem/accounts';

import {init} from '../src/init.mjs';
import {currentAddress, retire} from '../src/key.mjs';

let home;
let keyFile;

/// Two fixed keys, so a collision test can name which one it expects to find where.
const KEY_A = '0x1111111111111111111111111111111111111111111111111111111111111111';
const KEY_B = '0x2222222222222222222222222222222222222222222222222222222222222222';

/** Runs the command with stdout captured, and returns its `--json` payload. */
async function run(argv) {
  const written = [];
  const real = console.log;
  console.log = (...args) => written.push(args.join(' '));
  try {
    await init([...argv, '--json']);
  } finally {
    console.log = real;
  }
  return JSON.parse(written.join('\n'));
}

const keyOf = (path) => readFileSync(path, 'utf8').trim();
const mode = (path) => statSync(path).mode & 0o777;
const retiredFiles = () => readdirSync(home).filter((f) => f.startsWith('agent.pk.retired-')).sort();

describe('kairence init', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kairence-cli-'));
    keyFile = join(home, 'agent.pk');
    process.env.KAIRENCE_KEY_FILE = keyFile;
    process.env.KAIRENCE_CONFIG_FILE = join(home, 'config.json');
  });

  afterEach(() => {
    delete process.env.KAIRENCE_KEY_FILE;
    delete process.env.KAIRENCE_CONFIG_FILE;
  });

  it('mints one key, readable only by its owner, and never prints it', async () => {
    const out = await run([]);

    assert.equal(out.created, true);
    assert.equal(out.keyFile, keyFile);
    assert.equal(out.retiredKeyFile, null);
    assert.equal(out.address, privateKeyToAccount(keyOf(keyFile)).address);
    assert.equal(mode(keyFile), 0o600);
    assert.equal(JSON.stringify(out).includes(keyOf(keyFile)), false, 'the key itself must never leave');
  });

  it('re-running without --rotate mints nothing and moves nothing', async () => {
    const first = await run([]);
    const key = keyOf(keyFile);

    const second = await run([]);

    assert.equal(second.created, false);
    assert.equal(second.address, first.address);
    assert.equal(keyOf(keyFile), key, 'the standing key is untouched');
    assert.deepEqual(retiredFiles(), [], 'nothing was retired');
  });

  it('KEEPS EVERY RETIRED KEY across back-to-back rotations', async () => {
    const first = await run([]);
    const firstKey = keyOf(keyFile);

    // Back to back, deliberately: a name built to second precision collides here, and a clobbering
    // rename would eat the first retired key - the one that is still the account. The collision
    // BRANCH itself is forced by the frozen-clock test below; this one is the end-to-end shape.
    const second = await run(['--rotate']);
    const secondKey = keyOf(keyFile);
    const third = await run(['--rotate']);

    const retired = retiredFiles();
    assert.equal(retired.length, 2, 'both rotations left a file behind');
    assert.equal(second.retiredAddress, first.address);
    assert.equal(third.retiredAddress, second.address);

    // Every one of the three keys is distinct, and each retired file holds exactly the key that
    // was standing when it was retired.
    const kept = retired.map((f) => keyOf(join(home, f)));
    assert.deepEqual(new Set([...kept, keyOf(keyFile)]).size, 3, 'three distinct keys survive');
    assert.deepEqual(new Set(kept), new Set([firstKey, secondKey]));
    assert.equal(privateKeyToAccount(keyOf(keyFile)).address, third.address);
    for (const f of retired) assert.equal(mode(join(home, f)), 0o600, 'a retired key stays private');
  });

  it('a frozen clock forces the name collision, and the retry keeps both keys', () => {
    // The wall clock cannot be relied on to collide: the stamp carries milliseconds, so two real
    // rotations almost never land on one name and the retry branch would go unexercised. Freezing
    // Date makes the collision certain, which is the only way to prove the branch does its job.
    mock.timers.enable({apis: ['Date'], now: 1_787_000_000_000});
    try {
      writeFileSync(keyFile, `${KEY_A}\n`, {mode: 0o600});
      const first = retire(keyFile);
      writeFileSync(keyFile, `${KEY_B}\n`, {mode: 0o600});
      const second = retire(keyFile);

      assert.notEqual(first, second, 'one timestamp must not produce one name');
      assert.match(second, /-2$/, 'the counter is what breaks the tie');
      assert.equal(keyOf(first), KEY_A, 'the first retired key is intact');
      assert.equal(keyOf(second), KEY_B, 'and so is the second');
      assert.equal(retiredFiles().length, 2, 'nothing was overwritten');
    } finally {
      mock.timers.reset();
    }
  });

  it('rotation reports the file it wrote, and that file is the one that moved', async () => {
    await run([]);
    const key = keyOf(keyFile);

    const out = await run(['--rotate']);

    assert.equal(keyOf(out.retiredKeyFile), key);
    assert.notEqual(keyOf(keyFile), key);
    assert.equal(out.address, privateKeyToAccount(keyOf(keyFile)).address);
  });

  it('refuses a key file it cannot read rather than minting over it', async () => {
    writeFileSync(keyFile, 'not a key\n', {mode: 0o600});

    await assert.rejects(() => run([]), /does not hold a private key/);
    assert.equal(keyOf(keyFile), 'not a key', 'the unreadable file is left exactly as found');
    assert.throws(() => currentAddress(keyFile), /does not hold a private key/);
  });
});
