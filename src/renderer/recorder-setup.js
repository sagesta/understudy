'use strict';
const $ = (id) => document.getElementById(id);
const api = window.recorder;
let busy = false, revision = 0;
function render(state) {
  $('status').dataset.state = state.state;
  $('label').textContent = state.label;
  $('message').textContent = state.message;
  $('autostart').checked = state.autoStart;
}
async function act(fn) {
  if (busy) return;
  busy = true;
  for (const id of ['paste', 'connect', 'autostart']) $(id).disabled = true;
  try { render(await fn()); }
  catch { $('message').textContent = 'The recorder could not update. Open it from the tray and try again.'; }
  finally {
    busy = false;
    for (const id of ['paste', 'connect', 'autostart']) $(id).disabled = false;
  }
}
$('paste').addEventListener('click', () => act(() => api.pasteFromClipboard()));
$('connect').addEventListener('click', () => {
  if (busy) return;
  const text = $('settings').value;
  // Do not retain the manual paste in the page after submission, even on validation failure.
  $('settings').value = '';
  act(() => api.connect(text));
});
$('autostart').addEventListener('change', () => act(() => api.setAutoStart($('autostart').checked)));
api.onState((state) => { revision++; render(state); });
const initial = revision;
api.getState().then((state) => { if (revision === initial) render(state); }).catch(() => {
  $('message').textContent = 'The recorder could not update. Open it from the tray and try again.';
});
