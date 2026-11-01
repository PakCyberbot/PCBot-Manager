'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INDEX_FILE = path.join(DATA_DIR, 'trash-index.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(index) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function addEntry(entry) {
  const index = load();
  const id = crypto.randomBytes(8).toString('hex');
  index[id] = entry;
  save(index);
  return id;
}

function removeEntry(id) {
  const index = load();
  delete index[id];
  save(index);
}

function getEntry(id) {
  return load()[id];
}

function listEntries() {
  const index = load();
  return Object.entries(index).map(([id, v]) => ({ id, ...v }));
}

module.exports = { load, save, addEntry, removeEntry, getEntry, listEntries };
