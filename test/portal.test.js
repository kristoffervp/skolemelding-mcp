import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Portal } from '../src/portal.js';

const assets = 'https://portal.skoleplattform.no/globalassets/attachments/';

function message(id, extra = {}) {
  return { Id: id, Header: `Subject ${id}`, From: 'Teacher', Timestamp: '2026-10-01T08:00:00',
    IsMessageSeen: false, Body: `<p>Body&nbsp;${id}</p>`, Attachments: [], ...extra };
}

function fakeMobile(messages, { bytes = Buffer.from('file'), mimeType = 'application/pdf' } = {}) {
  const calls = { pages: [], attachments: [] };
  return {
    calls,
    async searchPage(page, pageSize) {
      calls.pages.push({ page, pageSize });
      const start = (page - 1) * pageSize;
      return { Result: messages.slice(start, start + pageSize), TotalMatching: messages.length };
    },
    async getAttachment(url) {
      calls.attachments.push(url);
      return { bytes, mimeType };
    },
  };
}

const inbox = (count) => Array.from({ length: count }, (_, index) => message(1000 - index));

test('listing pages through the inbox with one page size and stops on a short page', async () => {
  const mobile = fakeMobile(inbox(20));
  const listed = await new Portal({ mobile }).listMessages(100);
  assert.equal(listed.length, 20);
  assert.deepEqual(mobile.calls.pages, [{ page: 1, pageSize: 15 }, { page: 2, pageSize: 15 }]);
  assert.deepEqual(listed[0], { id: '1000', subject: 'Subject 1000', sender: 'Teacher', recipients: '',
    date: '2026-10-01T08:00:00', unread: true, attachmentNames: [], preview: 'Body 1000' });
});

test('messages seen by a search are read from the cache', async () => {
  const mobile = fakeMobile(inbox(40));
  const portal = new Portal({ mobile });
  await portal.listMessages(30);
  const pages = mobile.calls.pages.length;
  const found = await portal.getMessage('975');
  assert.equal(found.bodyText, 'Body 975');
  assert.equal(mobile.calls.pages.length, pages);
  await portal.getMessage('962');
  assert.equal(mobile.calls.pages.length, pages + 3);
  await assert.rejects(portal.getMessage('1'), /not found/);
});

test('HTML is returned only when requested', async () => {
  const portal = new Portal({ mobile: fakeMobile([message(7)]) });
  assert.equal('bodyHtml' in await portal.getMessage('7'), false);
  assert.equal((await portal.getMessage('7', { includeHtml: true })).bodyHtml, '<p>Body&nbsp;7</p>');
});

test('only portal attachment URLs are exposed', async () => {
  const portal = new Portal({ mobile: fakeMobile([message(7, { Attachments: [
    `${assets}Plan%20uke%2042.pdf`, 'https://example.com/globalassets/attachments/x.pdf',
    '/other/x.pdf', null,
  ] })]) });
  const found = await portal.getMessage('7');
  assert.deepEqual(found.attachments, [{ id: '7:0', name: 'Plan uke 42.pdf' }]);
  await assert.rejects(portal.getAttachment('7:1'), /Attachment not found/);
});

test('attachments are saved privately and only returned when asked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skolemelding-mcp-test-'));
  try {
    const mobile = fakeMobile([message(7, { Attachments: [`${assets}..%2F..%2Fescape.pdf`] })]);
    const portal = new Portal({ mobile, attachmentDir: join(directory, 'attachments') });
    const saved = await portal.getAttachment('7:0');
    assert.deepEqual(saved, { id: '7:0', name: '../../escape.pdf', mimeType: 'application/pdf', size: 4,
      path: join(directory, 'attachments', '7-0-.._.._escape.pdf') });
    assert.equal(await readFile(saved.path, 'utf8'), 'file');
    if (process.platform !== 'win32') assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
    const withContent = await portal.getAttachment('7:0', { includeContent: true });
    assert.equal(withContent.bytes.toString(), 'file');
    assert.equal(mobile.calls.pages.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
