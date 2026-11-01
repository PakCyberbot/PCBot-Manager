'use strict';
const fs = require('fs');
const path = require('path');
const { runPs, psQuote } = require('./ps');

function absExisting(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Expected an absolute path');
  const n = path.resolve(p);
  if (!fs.existsSync(n)) throw new Error('Path does not exist: ' + n);
  return n;
}

// Opens a file/shortcut/exe with its default handler (ShellExecute, so UAC and file associations behave normally).
async function open(p) {
  const n = absExisting(p);
  await runPs(`Start-Process -FilePath ${psQuote(n)}`);
}

async function reveal(p) {
  const n = absExisting(p);
  await runPs(`Start-Process explorer.exe -ArgumentList ('/select,"' + ${psQuote(n)} + '"')`);
}

async function terminal(p) {
  let dir = absExisting(p);
  if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  const arg = dir.endsWith('\\') ? dir + '.' : dir;
  await runPs(`
$d = ${psQuote(arg)}
if (Get-Command wt.exe -ErrorAction SilentlyContinue) { Start-Process wt.exe -ArgumentList ('-d "' + $d + '"') }
else { Start-Process powershell.exe -WorkingDirectory $d }`);
}

module.exports = { open, reveal, terminal, absExisting };
