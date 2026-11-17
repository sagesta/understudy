'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { channelPlan } = require('../src/main/channel-plan');
const { DEFAULTS, merge } = require('../src/main/settings');

const identity = { me: 'me', them: 'them' };

for (const remote of [true, false]) for (const listen of ['room', 'computer']) for (const micFrom of ['main', 'recorder'])
  for (const mic of [true, false]) for (const system of [true, false]) {
    test('channel plan: ' + JSON.stringify({ remote, listen, micFrom, mic, system }), () => {
      const s = { remote: { enabled: remote, host: '127.0.0.1', listen, micFrom }, audio: { captureMic: mic, captureSystem: system } };
      const before = structuredClone(s), channels = [...(mic ? ['me'] : []), ...(remote || system ? ['them'] : [])];
      const roomRemote = remote && listen === 'room', room = roomRemote || (!remote && mic && !system);
      assert.deepEqual(channelPlan(s), { remote, micRemote: !roomRemote && remote && micFrom === 'recorder' && mic, roomRemote,
        channels: roomRemote ? ['them'] : channels,
        localCapture: roomRemote ? [] : remote ? (micFrom === 'recorder' || !mic ? [] : ['me']) : channels,
        room, audioMap: room && !roomRemote ? { me: 'them' } : identity, error: roomRemote || channels.length ? '' : error });
      assert.deepEqual(s, before);
    });
  }
const error = 'Both the microphone and the computer audio are switched off in Settings. Turn at least one on.';

for (const mic of [true, false]) {
  test(`remote computer audio uses the recorder microphone by default when captureMic is ${mic}`, () => {
    for (const system of [true, false]) {
      const s = merge(DEFAULTS, { audio: { captureMic: mic, captureSystem: system }, remote: { enabled: true, host: '127.0.0.1', listen: 'computer' } });
      const before = structuredClone(s);
      assert.deepEqual(channelPlan(s), { remote: true, channels: mic ? ['me', 'them'] : ['them'],
        micRemote: mic, roomRemote: false, localCapture: [], room: false, audioMap: identity, error: '' });
      assert.deepEqual(s, before, 'planning leaves Settings alone');
    }
  });
}

for (const mic of [true, false]) for (const system of [true, false]) {
  test(`local audio keeps the old behaviour for mic ${mic} and system ${system}`, () => {
    const channels = [...(mic ? ['me'] : []), ...(system ? ['them'] : [])], room = mic && !system;
    const expected = { remote: false, micRemote: false, roomRemote: false, channels, localCapture: channels, room,
      audioMap: room ? { me: 'them' } : identity, error: channels.length ? '' : error };
    for (const remote of [{ enabled: false, host: '127.0.0.1' }, { enabled: true, host: '' }, undefined]) {
      assert.deepEqual(channelPlan({ audio: { captureMic: mic, captureSystem: system }, remote }), expected);
    }
  });
}

test('missing audio switches retain the default of both inputs being on', () => {
  assert.deepEqual(channelPlan({ audio: {} }), { remote: false, channels: ['me', 'them'],
    micRemote: false, roomRemote: false, localCapture: ['me', 'them'], room: false, audioMap: identity, error: '' });
});


test('default remote room ignores both local switches and captures no local device', () => {
  const s = merge(DEFAULTS, { remote: { enabled: true, host: '127.0.0.1' }, audio: { captureMic: false, captureSystem: false } });
  assert.deepEqual(channelPlan(s), { remote: true, roomRemote: true, micRemote: false, room: true,
    channels: ['them'], localCapture: [], audioMap: identity, error: '' });
});
