// Run with: node test/updates.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isNewer } = require('../updates.js');

assert.equal(isNewer('1.2.0', '1.1.9'), true);
assert.equal(isNewer('v1.1.0', '1.1.0'), false);
assert.equal(isNewer('1.0.10', '1.0.9'), true); // numeric, not text, comparison
assert.equal(isNewer('0.9.0', '1.0.0'), false);
console.log('updates ok');
