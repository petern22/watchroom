// Run with: node test/meters.test.mjs
import assert from 'node:assert/strict';
import { megabitsPerSecond, lossPercent, pictureName, smoothnessLevel, speedLevel, delayLevel, overallLevel } from '../renderer/meters.mjs';

assert.equal(megabitsPerSecond(1_250_000, 0, 1), 10); // 1.25 MB in one second is 10 Mbps
assert.equal(lossPercent(990, 10, 0, 0), 1); // 10 lost of 1000
assert.equal(pictureName(1080), 'Full HD');
assert.equal(pictureName(2160), '4K');
assert.equal(smoothnessLevel(0.1, 60, 60), 4);
assert.equal(smoothnessLevel(0.1, 20, 60), 1); // frames dropping below half the target
assert.equal(speedLevel(6, 20), 4); // plenty of headroom
assert.equal(speedLevel(6, 6.5), 2); // barely enough
assert.equal(delayLevel(120), 4);
assert.equal(overallLevel(4, 3, 1, 4), 1);
console.log('meters ok');
