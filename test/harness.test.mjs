// Which Hermes profile an agent gets, and what happens when two agents want the same name.
//
// The address is the identity and the ticker is a handle. These tests pin the seam between them:
// a handle may collide, and when it does the answer must still be one agent, never a shared one.

import {strict as assert} from 'node:assert';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const KAI = '0xca18A528Ea897040f715edC92e6e4572780c5ca1';
const WOOF = '0xd193604529Ac73f252C8c9e1b8BbC45db260Dca1';

async function hermes(profiles = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kairence-hermes-'));
  process.env.HERMES_HOME = root;
  writeFileSync(join(root, 'SOUL.md'), 'stock\n');
  for (const [name, claim] of Object.entries(profiles)) {
    const dir = join(root, 'profiles', name);
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'SOUL.md'), 'stock\n');
    if (claim) writeFileSync(join(dir, '.env'), `A=1\nKAIRENCE_TOKEN=${claim}\n`);
  }
  return {root, ...(await import(`../src/harness.mjs?${Math.random()}`))};
}

test('a ticker becomes a handle a human can type', async () => {
  const h = await hermes();
  assert.equal(h.profileName('WOOF', WOOF).base, 'woof');
  assert.equal(h.profileName('WOOF', WOOF).unique, 'woof-0dca1');
});

test('the profile that already names this token is its home, whatever it is called', async () => {
  const h = await hermes({somethingelse: WOOF});
  const {profile, created} = await h.profileFor(WOOF, 'WOOF');
  assert.equal(profile.name, 'somethingelse');
  assert.equal(created, false);
});

test('an unclaimed profile under the agent name is adopted, not duplicated', async () => {
  const h = await hermes({woof: null, other: KAI});
  const {profile, created} = await h.profileFor(WOOF, 'WOOF');
  assert.equal(profile.name, 'woof');
  assert.equal(created, false);
});

test('a colliding ticker falls back to the address tail rather than sharing a prompt', async () => {
  // `woof` is taken by KAI - an agent that calls itself WOOF must not land in it.
  const h = await hermes({woof: KAI});
  await assert.rejects(
    () => h.profileFor(WOOF, 'WOOF'),
    // No hermes binary in the test environment, so creation fails - but the NAME it tried for is
    // the separated one, which is what this pins.
    (e) => {
      assert.match(e.message, /woof-0dca1/);
      return true;
    },
  );
});

test('a name asked for explicitly is never quietly changed', async () => {
  const h = await hermes({woof: KAI, mine: KAI});
  await assert.rejects(() => h.profileFor(WOOF, 'WOOF', 'mine'), /already belongs to/);
});

test('a cloned profile does not keep the other agent\'s Venice key', async () => {
  const h = await hermes({woof: null});
  const {writeFileSync, readFileSync} = await import('node:fs');
  const profile = h.hermesProfiles().find((p) => p.name === 'woof');
  writeFileSync(profile.env, 'MODEL=glm\nVENICE_API_KEY=someone-elses\nOTHER=1\n');
  h.disinherit(profile);
  const after = readFileSync(profile.env, 'utf8');
  assert.equal(after.includes('VENICE_API_KEY'), false, 'the inherited key must be gone');
  assert.equal(after.includes('MODEL=glm'), true, 'shared config must survive');
  assert.equal(after.includes('OTHER=1'), true);
});

test('setEnv replaces a line rather than growing a second one', async () => {
  const h = await hermes();
  const path = join(h.root, '.env');
  writeFileSync(path, 'A=1\nKAIRENCE_TOKEN=old\n');
  h.setEnv(path, 'KAIRENCE_TOKEN', WOOF);
  const {readFileSync} = await import('node:fs');
  const text = readFileSync(path, 'utf8');
  assert.equal(text, `A=1\nKAIRENCE_TOKEN=${WOOF}\n`);
});
