'use strict';
const MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.3gp': 'video/3gpp', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json',
  '.apk': 'application/vnd.android.package-archive', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function mimeFor(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return MAP[ext] || 'application/octet-stream';
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic']);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.3gp', '.avi']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.opus']);

function kindFor(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.apk') return 'apk';
  return 'file';
}

module.exports = { mimeFor, kindFor };
