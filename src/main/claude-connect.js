'use strict';
// Registers the Understudy meetings server with Claude Desktop, so Claude can
// read the meeting library directly.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeAtomic } = require('./settings');

const SERVER_NAME = 'understudy';

// Where Claude Desktop keeps claude_desktop_config.json, most likely first.
function configCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  const out = [];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    // Store-packaged installs keep their data under Packages\<package>\LocalCache\Roaming.
    try {
      for (const d of fs.readdirSync(path.join(local, 'Packages'))) {
        if (/^(AnthropicPBC\.)?Claude/i.test(d)) out.push(path.join(local, 'Packages', d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
      }
    } catch { /* no Packages folder */ }
    out.push(path.join(roaming, 'Claude', 'claude_desktop_config.json'));
  } else if (platform === 'darwin') {
    out.push(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  } else {
    out.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json'));
  }
  return out;
}

function pickConfigPath(candidates) {
  return candidates.find((p) => fs.existsSync(p)) || candidates.find((p) => fs.existsSync(path.dirname(p))) || null;
}

// `notesDir` (the app's Notes folder) turns on the connector's notes tools; without it the entry is the same as it always was.
// `issuesDir` (the Issues folder, see issues.js) turns on list_issues and get_issue the same way.
function serverEntry({ execPath, serverPath, meetingsDir, notesDir, issuesDir }) {
  // The app's own runtime runs the server, so nothing else has to be installed.
  const env = { ELECTRON_RUN_AS_NODE: '1', UNDERSTUDY_MEETINGS_DIR: meetingsDir };
  if (typeof notesDir === 'string' && notesDir) env.UNDERSTUDY_NOTES_DIR = notesDir;
  if (typeof issuesDir === 'string' && issuesDir) env.UNDERSTUDY_ISSUES_DIR = issuesDir;
  return { command: execPath, args: [serverPath], env };
}

// Double quotes work in both Command Prompt and PowerShell. PowerShell would
// expand $ and backticks inside them, so those are escaped; trailing backslashes
// are doubled so they cannot escape the closing quote in CommandLineToArgvW.
function shq(s) {
  return `"${String(s).replace(/[\r\n\u0000]+/g, '').replace(/[`$]/g, '`$&').replace(/"/g, '').replace(/\\+$/, '$&$&')}"`;
}

function readConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
  return raw.trim() ? JSON.parse(raw) : {};
}
const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// `opts.configPath` names the config file outright. Test runs of the app and
// the tests pass it, so they can never rewrite the user's real Claude config.
function info(opts) {
  const entry = serverEntry(opts);
  const configPath = opts.configPath || pickConfigPath(configCandidates());
  let installed = false, stale = false;
  if (configPath && fs.existsSync(configPath)) {
    try {
      const j = readConfig(configPath);
      const have = j.mcpServers && j.mcpServers[SERVER_NAME];
      installed = Boolean(have);
      stale = installed && !sameEntry(have, entry); // points at another install or folder
    } catch {}
  }
  return {
    configPath, installed, stale, claudeFound: Boolean(configPath),
    snippet: JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2),
    meetingsDir: opts.meetingsDir,
    notesDir: typeof opts.notesDir === 'string' && opts.notesDir ? opts.notesDir : '',
    issuesDir: typeof opts.issuesDir === 'string' && opts.issuesDir ? opts.issuesDir : '',
    // Single-quoted so that nothing in a folder name is interpreted by the shell.
    claudeCode: `claude mcp add ${SERVER_NAME} --env UNDERSTUDY_MEETINGS_DIR=${shq(opts.meetingsDir)}${typeof opts.notesDir === 'string' && opts.notesDir ? ` --env UNDERSTUDY_NOTES_DIR=${shq(opts.notesDir)}` : ''}${typeof opts.issuesDir === 'string' && opts.issuesDir ? ` --env UNDERSTUDY_ISSUES_DIR=${shq(opts.issuesDir)}` : ''} --env ELECTRON_RUN_AS_NODE=1 -- ${shq(opts.execPath)} ${shq(opts.serverPath)}`,
  };
}

function install(opts, configPath = opts.configPath || pickConfigPath(configCandidates())) {
  if (!configPath) throw new Error('Claude Desktop does not appear to be installed on this computer. Copy the configuration shown and add it by hand once it is.');
  let config = {};
  if (fs.existsSync(configPath)) {
    try { config = readConfig(configPath); } catch { throw new Error(`${configPath} is not valid JSON, so it was left untouched. Fix it or add the configuration by hand.`); }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${configPath} does not hold a settings object, so it was left untouched.`);
    // An array, a string or a number where the servers should be: adding an entry would be lost or wrong, so nothing is written.
    const servers = config.mcpServers;
    if (servers !== undefined && servers !== null && (typeof servers !== 'object' || Array.isArray(servers))) throw new Error(`${configPath} has "mcpServers" set to something other than a list of servers, so it was left untouched. Fix it or add the configuration by hand.`);
    // Keep the file as it was before this app first touched it; never overwrite that copy.
    const backup = `${configPath}.before-understudy.bak`;
    try { fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
  config.mcpServers[SERVER_NAME] = serverEntry(opts);
  writeAtomic(configPath, JSON.stringify(config, null, 2));
  return { configPath };
}

// Rewrites an existing "understudy" entry when the app or the meetings folder
// has moved. Does nothing if Claude was never connected.
function refresh(opts) {
  const i = info(opts);
  if (i.installed && i.stale) install(opts, i.configPath);
  return i.stale;
}

module.exports = { refresh, info, install, configCandidates, pickConfigPath, serverEntry, SERVER_NAME, shq };
