'use strict';

function createConnectionTest({ remoteConfig, settings, createListener, isMeetingRunning, timeoutMs = 30000, afterMs = 1500 }) {
  let current = null;
  const reply = (result, message) => ({ result, message });
  function finish(test, result) {
    if (test.closing) return test.closing;
    test.ending = true;
    clearTimeout(test.deadline); clearTimeout(test.after);
    test.closing = Promise.resolve().then(async () => {
      // Closing also waits for a pending bind, so cancellation cannot hand a busy port to a meeting.
      if (test.listener) { try { await test.listener.close(); } catch { /* never expose a transport error */ } }
      if (current === test) current = null;
      test.resolve(result);
    });
    return test.closing;
  }
  function run() {
    if (isMeetingRunning()) return Promise.resolve(reply('busy', 'A meeting is running. Start the recorder there instead.'));
    if (current) return Promise.resolve(reply('busy', 'A test is already running.'));
    const { host, port } = settings.get().remote;
    if (!host) return Promise.resolve(reply('setup', "Enter this PC's Tailscale address first."));
    const test = { ending: false, reached: false };
    const result = new Promise((resolve) => { test.resolve = resolve; });
    current = test;
    const failed = () => finish(test, reply('error', `Could not listen on ${host}:${port}. Check the Tailscale address in Settings, or whether another program uses that port.`));
    try {
      // No audio, status or gap callbacks: this checks authentication without recording or echoing peer data.
      test.listener = createListener({ token: remoteConfig.token(), host, port, onState(state) {
        if (state !== 'connected' || test.ending || test.reached) return;
        test.reached = true; clearTimeout(test.deadline);
        test.resolve(reply('reached', 'The recorder reached this PC.'));
        // The recorder needs a moment to display its waiting state; a meeting can cancel this grace period.
        test.after = setTimeout(() => finish(test), afterMs); test.after.unref();
      } });
      test.deadline = setTimeout(() => finish(test, reply('nothing', `Nothing arrived in ${timeoutMs / 1000} seconds. Check that Tailscale is on for both PCs, the address above, and Windows Firewall.`)), timeoutMs);
      test.deadline.unref();
      Promise.resolve(test.listener.listen()).catch(failed);
    } catch { failed(); }
    return result;
  }
  return {
    run,
    async cancel() { if (current) await finish(current, reply('cancelled', 'Test stopped.')); },
    active: () => current !== null,
  };
}

module.exports = { createConnectionTest };
