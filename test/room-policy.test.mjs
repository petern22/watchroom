// Run with: node test/room-policy.test.mjs
import assert from 'node:assert/strict';

import { createAttemptGate, MAX_PEERS, UPLOAD_BUDGET_BPS, bitrateFor, cleanCode, normalizeProfile } from '../renderer/room-policy.mjs';

assert.deepEqual(normalizeProfile('1080', 60), {
  quality: '1080',
  fps: 60,
  width: 1920,
  height: 1080,
  label: '1080p',
});
assert.equal(normalizeProfile('invalid', 120).quality, '720');
assert.equal(bitrateFor('2160', 60, 2), UPLOAD_BUDGET_BPS / 2);
assert.equal(bitrateFor('2160', 60, 10) * 10, UPLOAD_BUDGET_BPS);
assert.equal(bitrateFor('720', 30, 0), 3e6);
assert.equal(cleanCode(' ab-12!cd '), 'AB12CD');
assert.equal(cleanCode(null), '');
assert.equal(MAX_PEERS, 8);

{
  const gate = createAttemptGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false, 'a newer room entry supersedes an older one');
  assert.equal(gate.isCurrent(second), true);
  gate.cancel();
  assert.equal(gate.isCurrent(second), false, 'leaving cancels an entry that is still waiting');
}

console.log('room policy ok');
