import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, rename, unlink, writeFile } from 'node:fs/promises';
import { PublicError } from './errors.js';

// Marks a file as downloaded from the internet, so macOS Gatekeeper and Windows warn before opening it.
async function markDownloaded(path) {
  if (process.platform === 'darwin') {
    const value = `0083;${Math.floor(Date.now() / 1000).toString(16)};skolemelding-mcp;`;
    await new Promise((resolve) => execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, path], () => resolve()));
  } else if (process.platform === 'win32') {
    await writeFile(`${path}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(() => {});
  }
}

// Writes a new private file under a random name and renames it into place, so an existing file or symlink
// at the path is replaced instead of written through, and readers never see a partial file.
export async function writePrivateFile(path, data, { downloaded = false } = {}) {
  const temporaryPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, data, { mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, 0o600);
    if (downloaded) await markDownloaded(temporaryPath);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

// Reads a response body up to maxBytes, so an oversized reply cannot fill the memory of a small computer.
export async function readLimited(response, maxBytes, message) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new PublicError(message);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new PublicError(message);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
