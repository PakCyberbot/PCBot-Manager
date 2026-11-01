'use strict';
const { spawn } = require('child_process');

const PRELUDE = [
  "$ProgressPreference='SilentlyContinue'",
  "$ErrorActionPreference='Continue'",
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  'function ToMs($d){ if($null -eq $d){ return $null }; try { return ([DateTimeOffset]([datetime]$d)).ToUnixTimeMilliseconds() } catch { return $null } }',
].join('; ');

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Bulk data goes over stdin as `input` (read in the script via $STDIN): the encoded script
// travels on the command line, which Windows caps at 32,767 characters.
function runPs(script, { timeoutMs = 120000, input } = {}) {
  const stdinReader = input !== undefined ? '$STDIN = [Console]::In.ReadToEnd()\n' : '';
  const encoded = Buffer.from(PRELUDE + '\n' + stdinReader + script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    child.stdin.on('error', () => {});
    child.stdin.end(input !== undefined ? input : undefined);
    const out = [];
    const err = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('PowerShell timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(Buffer.concat(err).toString('utf8').trim() || `PowerShell exited ${code}`));
      }
      resolve(stdout);
    });
  });
}

async function psJson(script, opts) {
  const out = (await runPs(script, opts)).replace(/^﻿/, '').trim();
  if (!out) return null;
  return JSON.parse(out);
}

function arr(x) {
  if (x === null || x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

module.exports = { runPs, psJson, psQuote, arr };
