// Run with: node test/extras.test.mjs
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, cleanSettings, formatTogether, heartScale, isHeart } from '../renderer/extras.js';

assert.deepEqual(cleanSettings(null), DEFAULT_SETTINGS);
assert.equal(cleanSettings({ micMode: 'weird' }).micMode, 'always');
assert.equal(cleanSettings({ micMode: 'voice' }).micMode, 'voice');
assert.equal(cleanSettings({ threshold: 900 }).threshold, 100);
assert.equal(cleanSettings({ threshold: 'x' }).threshold, DEFAULT_SETTINGS.threshold);
assert.equal(cleanSettings({ duck: -5 }).duck, 0);
assert.equal(cleanSettings({ notify: false }).notify, false);
assert.equal(cleanSettings({ hearts: 0 }).hearts, false);

assert.equal(isHeart('love you ❤️'), true);
assert.equal(isHeart('💕'), true);
assert.equal(isHeart('😍'), true);
assert.equal(isHeart('hello there'), false);
assert.equal(isHeart(undefined), false);

assert.equal(heartScale(0), 0, 'the heart starts from nothing');
assert.ok(heartScale(0.75) > heartScale(0.9), 'the heart beats');
assert.ok(heartScale(3.3) > 1.5, 'the heart swells as it leaves');

assert.equal(formatTogether(5400), '1.5 hours together');
assert.equal(formatTogether(3600), '1 hour together');
assert.match(formatTogether(10), /first hour/);

console.log('extras ok');
