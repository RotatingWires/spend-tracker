// File > iPhone Shortcut...: the address and key an iPhone Shortcut uses to add purchases (MANUAL.md, iPhone Shortcut).
import { $, api, formatDateTime } from './app.js';
import { closeMenus, confirmAction, setStatus } from './widgets.js';

let keyCreatedAt = null;

function showKeyState() {
  $('#shortcutStatus').textContent = keyCreatedAt
    ? `On, with a key created ${formatDateTime(keyCreatedAt)}. The key is never shown again; Replace Key makes a new one and the old one stops working.`
    : 'Off: there is no key yet. Create Key turns the Shortcut on.';
  $('#shortcutCreateButton').textContent = keyCreatedAt ? 'Replace Key' : 'Create Key';
  $('#shortcutOffButton').hidden = !keyCreatedAt;
}

function showNewKey(key) {
  $('#shortcutKeyBox').hidden = !key;
  $('#shortcutKey').value = key ?? '';
}

async function openShortcut() {
  closeMenus();
  $('#shortcutAddress').textContent = `${location.origin}/api/shortcut/entries`;
  showNewKey(null);
  $('#shortcutStatus').textContent = 'Checking the Shortcut key...';
  $('#shortcutCreateButton').disabled = true;
  $('#shortcutOffButton').hidden = true;
  $('#shortcutDialog').showModal();
  try {
    keyCreatedAt = (await api('/shortcut')).keyCreatedAt;
    showKeyState();
    $('#shortcutCreateButton').disabled = false;
  } catch (error) {
    $('#shortcutStatus').textContent = `Could not check the Shortcut key: ${error.message}`;
  }
}

async function createKey() {
  if (keyCreatedAt && !await confirmAction('Replace Key', 'Make a new key? The Shortcut on your phone stops adding entries until you paste the new key into it.', 'Replace Key')) return;
  try {
    const created = await api('/shortcut/key', { method: 'POST' });
    keyCreatedAt = created.keyCreatedAt;
    showKeyState();
    showNewKey(created.key);
    $('#shortcutKey').select();
    setStatus('Created a new iPhone Shortcut key.');
  } catch (error) {
    $('#shortcutStatus').textContent = `Could not create a key: ${error.message}`;
  }
}

async function turnOff() {
  if (!await confirmAction('Turn Off', 'Delete the key? The Shortcut stops adding entries; it keeps them on the phone until you create a new key and paste it in.', 'Turn Off')) return;
  try {
    await api('/shortcut/key', { method: 'DELETE' });
    keyCreatedAt = null;
    showKeyState();
    showNewKey(null);
    setStatus('Turned off the iPhone Shortcut.');
  } catch (error) {
    $('#shortcutStatus').textContent = `Could not turn the Shortcut off: ${error.message}`;
  }
}

// The clipboard API only works over HTTPS or on this computer; elsewhere the key stays selected to copy by hand.
async function copyKey() {
  const input = $('#shortcutKey');
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    setStatus('Copied the Shortcut key.');
  } catch {
    setStatus('The browser did not allow copying; the key is selected, so copy it yourself.');
  }
}

$('#shortcutMenuItem').addEventListener('click', openShortcut);
$('#shortcutCreateButton').addEventListener('click', createKey);
$('#shortcutOffButton').addEventListener('click', turnOff);
$('#shortcutCopyButton').addEventListener('click', copyKey);
