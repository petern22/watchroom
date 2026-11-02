// Run with: node test/relay.test.mjs
import assert from 'node:assert/strict';

import { matches, validEvent } from '../worker/relay/index.mjs';

const filter = { kinds: [20123], x: ['room-a'] };
const event = (over = {}) => ({ id: 'e1', kind: 20123, content: 'hi', tags: [['x', 'room-a']], ...over });

assert.equal(matches(filter, event()), true);
assert.equal(matches(filter, event({ tags: [['x', 'room-b']] })), false, 'other rooms are not delivered');
assert.equal(matches(filter, event({ kind: 20124 })), false, 'other kinds are not delivered');
assert.equal(validEvent(event()), true);
assert.equal(validEvent(event({ kind: 1 })), false, 'stored (non-ephemeral) kinds are refused');
assert.equal(validEvent(event({ content: 5 })), false);
assert.equal(validEvent(event({ tags: [['x', 7]] })), false);
assert.equal(validEvent(null), false);

console.log('relay ok');
