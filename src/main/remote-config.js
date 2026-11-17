'use strict';
const crypto = require('node:crypto');

function createRemoteConfig({ settings, clipboard, randomBytes = crypto.randomBytes, setTimeout: later = setTimeout }) {
  const replaceToken = () => {
    const value = randomBytes(24).toString('base64url');
    settings.setSecret('remoteToken', value);
    return value;
  };
  const token = () => settings.getSecret('remoteToken') || replaceToken();
  const info = () => {
    const { enabled, host, port, listen, micFrom } = settings.get().remote;
    // IPv6 literals need brackets to be usable as WebSocket URLs.
    const address = host ? `ws://${host.includes(':') ? `[${host}]` : host}:${port}` : '';
    return { enabled, host, port, listen, micFrom, hasToken: Boolean(settings.getSecret('remoteToken')), address };
  };
  return {
    info, token,
    newToken() { replaceToken(); return { hasToken: true }; },
    copySettings() {
      const { address } = info();
      if (!address) return false;
      // The clipboard is the only export path; a window never receives the token.
      const text = JSON.stringify({ url: address, token: token() });
      clipboard.writeText(text);
      // Leave later clipboard work alone, and do not keep the app open for this cleanup.
      later(() => { if (clipboard.readText() === text) clipboard.clear(); }, 30000).unref();
      return true;
    },
  };
}

module.exports = { createRemoteConfig };
