// Run with: node test/room-policy.test.mjs
import assert from 'node:assert/strict';

import { SPEAK_HOLD_MS, createAttemptGate, nextSpeaking, MAX_PEERS, UPLOAD_BUDGET_BPS, bitrateFor, cleanCode, normalizeProfile } from '../renderer/room-policy.mjs';

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

{
  let s = { speaking: false, loudAt: 0 };
  s = nextSpeaking({ level: 0.012, ...s, now: 1000 });
  assert.equal(s.speaking, true, 'a quiet voice (0.012) now counts as speaking');
  s = nextSpeaking({ level: 0.007, ...s, now: 1100 });
  assert.equal(s.speaking, true, 'between the two thresholds the flag stays on');
  s = nextSpeaking({ level: 0.001, ...s, now: 1200 });
  assert.equal(s.speaking, true, 'a short pause keeps the movie quiet');
  s = nextSpeaking({ level: 0.001, ...s, now: 1100 + SPEAK_HOLD_MS + 1 });
  assert.equal(s.speaking, false, 'after the hold the flag drops');
  assert.equal(nextSpeaking({ level: 0.008, speaking: false, loudAt: 0, now: 5000 }).speaking, false, 'noise below the on-level never starts it');
}

console.log('room policy ok');
