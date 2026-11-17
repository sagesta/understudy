'use strict';

function channelPlan(s) {
  const remote = s.remote?.enabled === true && Boolean(s.remote.host);
  // The recorder's room microphone is the only source, regardless of this PC's switches.
  const roomRemote = remote && s.remote.listen === 'room';
  if (roomRemote) return { remote, micRemote: false, roomRemote, channels: ['them'], localCapture: [],
    room: true, audioMap: { me: 'me', them: 'them' }, error: '' };
  const micRemote = remote && s.remote.micFrom === 'recorder' && s.audio.captureMic !== false;
  const channels = [];
  if (s.audio.captureMic !== false) channels.push('me');
  if (remote || s.audio.captureSystem !== false) channels.push('them');
  // A local microphone alone hears everybody; computer mode keeps it as the owner's voice.
  const room = !remote && channels.length === 1 && channels[0] === 'me';
  return {
    remote, micRemote, roomRemote, channels, localCapture: remote ? (s.remote.micFrom === 'recorder' ? [] : channels.filter((ch) => ch === 'me')) : channels,
    room, audioMap: room ? { me: 'them' } : { me: 'me', them: 'them' },
    error: channels.length ? '' : 'Both the microphone and the computer audio are switched off in Settings. Turn at least one on.'
  };
}

module.exports = { channelPlan };
