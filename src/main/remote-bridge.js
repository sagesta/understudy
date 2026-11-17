'use strict';
const noop = () => {};

function createBridge({ session, remoteConfig, settings, createListener, micRemote = false, roomRemote = false, onHint = noop,
  onCaptureStatus = noop, onState = noop, now = Date.now, drainMs = 250 }) {
  let listener, opening, closing, closed = false, draining = false, connected = false, wanted = 'stopped', lastCommand, stopAccepted = false;
  let lastHint = '', gapAt = -Infinity;
  const hint = (message) => {
    if (!message || message === lastHint) return;
    lastHint = message;
    onHint(message);
  };
  const command = (name) => {
    const sent = name === 'start' || name === 'resume' ? listener.command(name, { mic: !roomRemote && micRemote, ...(roomRemote ? { room: true } : {}) }) : listener.command(name);
    lastCommand = name;
    stopAccepted = name === 'stop' && Boolean(sent);
    return sent;
  };

  function open() {
    if (closed) return Promise.reject(new Error('The remote listener is closed.'));
    if (opening) return opening;
    const { host, port } = settings.get().remote;
    opening = (async () => {
      try {
        const token = remoteConfig.token();
        listener = createListener({ token, host, port,
          // Session owns the pause gate; only the meeting's plan authorises a remote microphone.
          onAudio(channel, pcm) { if ((!closed || draining) && (channel === 'them' || (channel === 'me' && micRemote && !roomRemote))) session.pushAudio(channel, pcm); },
          onGap() {
            const time = now();
            if (closed || time - gapAt < 20000) return;
            gapAt = time;
            hint('Some audio from the other PC was lost.');
          },
          onStatus({ state, hint: message }) {
            if (closed) return;
            // Even an authenticated recorder must not echo its credential into a window.
            const cleanHint = message ? message.replaceAll(token, '[removed]') : '';
            onCaptureStatus(state, cleanHint);
            if (cleanHint) hint(cleanHint);
          },
          onState(state) {
            connected = !closed && state === 'connected';
            if (!closed) {
              if (connected) {
                lastCommand = undefined;
                stopAccepted = false;
                if (wanted === 'recording') command('start');
                else if (wanted === 'paused') command('pause');
                hint('The recorder on the other PC is connected.');
              } else if (state === 'disconnected' && wanted !== 'stopped') {
                hint('The recorder on the other PC is not connected. Its audio is missing until it is back.');
              }
            }
            onState(state);
          }
        });
        await listener.listen();
      } catch {
        closed = true; draining = false; connected = false; wanted = 'stopped';
        if (listener) { try { await listener.close(); } catch { /* keep the plain bind error */ } }
        throw new Error(`Could not listen on ${host}:${port}. Check the Tailscale address in Settings, or whether another program uses that port.`);
      }
    })();
    return opening;
  }

  function setWanted(value) {
    if (closed) return;
    if (!['recording', 'paused', 'stopped'].includes(value)) throw new TypeError('Unknown remote recording state.');
    const previous = wanted;
    wanted = value;
    if (connected) command(value === 'recording' ? (previous === 'paused' ? 'resume' : 'start') : value === 'paused' ? 'pause' : 'stop');
  }

  function close() {
    if (closing) return closing;
    // Stop once and block reconnect callbacks while the recorder drains its last audio and the listener closes.
    const shouldDrain = connected && (lastCommand === 'stop' ? stopAccepted : command('stop'));
    closed = true; connected = false; wanted = 'stopped';
    draining = Boolean(shouldDrain && drainMs > 0);
    closing = (async () => {
      if (opening) { try { await opening; } catch { /* a failed bind is already closed */ } }
      if (draining) await new Promise((resolve) => setTimeout(resolve, drainMs));
      draining = false;
      if (listener) await listener.close();
    })();
    return closing;
  }
  return { open, setWanted, close, state: () => ({ wanted, connected }) };
}

module.exports = { createBridge };
