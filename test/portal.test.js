import assert from 'node:assert/strict';
import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Portal } from '../src/portal.js';

const assets = 'https://portal.skoleplattform.no/globalassets/attachments/';

function message(id, extra = {}) {
  return { Id: id, Header: `Subject ${id}`, From: 'Teacher', Timestamp: '2026-10-01T08:00:00',
    IsMessageSeen: false, Body: `<p>Body&nbsp;${id}</p>`, Attachments: [], ...extra };
}

function fakeMobile(messages, { bytes = Buffer.from('file'), mimeType = 'application/pdf', children } = {}) {
  const calls = { pages: [], attachments: [], children: 0 };
  return {
    calls,
    async getChildren() {
      calls.children++;
      if (!children) throw new Error('Child list unavailable');
      return children;
    },
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
  assert.deepEqual(listed[0], { id: '1000', subject: 'Subject 1000', sender: 'Teacher', children: [],
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

test('cached messages expire after five minutes, and concurrent lookups share one scan', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const mobile = fakeMobile(inbox(40));
  const portal = new Portal({ mobile });
  await Promise.all([portal.getMessage('962'), portal.getMessage('962')]);
  assert.equal(mobile.calls.pages.length, 3);
  await portal.getMessage('962');
  assert.equal(mobile.calls.pages.length, 3);
  t.mock.timers.tick(5 * 60_000);
  await portal.getMessage('962');
  assert.equal(mobile.calls.pages.length, 6);
});

test('threads are returned as plain text, with HTML only when requested', async () => {
  const thread = { ThreadId: 'abc', TimeStamp: '2026-10-02T09:00:00', DisplayText: 'Reply from teacher',
    IsSeen: false, ThreadText: '<p>See&nbsp;<b>you</b></p>', ReceiverId: null };
  const portal = new Portal({ mobile: fakeMobile([message(7, { Threads: [thread] })]) });
  const expected = { id: 'abc', date: '2026-10-02T09:00:00', label: 'Reply from teacher', unread: true, text: 'See you' };
  assert.deepEqual((await portal.getMessage('7')).threads, [expected]);
  assert.deepEqual((await portal.getMessage('7', { includeHtml: true })).threads,
    [{ ...expected, html: '<p>See&nbsp;<b>you</b></p>' }]);
});

test('long and unusual attachment names stay valid file names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skolemelding-mcp-test-'));
  const names = [`${'x'.repeat(300)}.pdf`, `${'a'.repeat(199)}\u{1F600}b.pdf`, `${'\u1200'.repeat(140)}.pdf`, 'a<b>|c?.docx. '];
  try {
    const portal = new Portal({
      mobile: fakeMobile([message(7, { Attachments: names.map((name) => assets + encodeURIComponent(name)) })]),
      attachmentDir: directory,
    });
    for (const [index, name] of names.entries()) {
      const saved = await portal.getAttachment(`7:${index}`);
      const base = saved.path.slice(directory.length + 1);
      assert.ok(Buffer.byteLength(base) <= 220, `${name} gave ${Buffer.byteLength(base)} bytes`);
      assert.ok(base.startsWith(`7-${index}-`));
      assert.ok((await readdir(directory)).includes(base), 'returned path must match the file on disk');
    }
    const files = await readdir(directory);
    assert.ok(files.some((file) => file.startsWith('7-0-') && file.endsWith('.pdf')));
    assert.ok(files.includes('7-3-a_b__c_.docx'));
    assert.equal(files.filter((file) => file.endsWith('.tmp')).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('saving replaces existing files and symlinks instead of writing through them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skolemelding-mcp-test-'));
  try {
    const portal = new Portal({
      mobile: fakeMobile([message(7, { Attachments: [`${assets}a.pdf`, `${assets}b.pdf`] })]),
      attachmentDir: join(directory, 'attachments'),
    });
    await portal.getAttachment('7:0');
    const loose = join(directory, 'attachments', '7-0-a.pdf');
    await writeFile(loose, 'old', { mode: 0o644 });
    const target = join(directory, 'outside.txt');
    await writeFile(target, 'keep');
    await symlink(target, join(directory, 'attachments', '7-1-b.pdf'));
    await Promise.all([portal.getAttachment('7:0'), portal.getAttachment('7:0'), portal.getAttachment('7:1')]);
    assert.equal(await readFile(loose, 'utf8'), 'file');
    assert.equal(await readFile(target, 'utf8'), 'keep');
    assert.equal((await lstat(join(directory, 'attachments', '7-1-b.pdf'))).isSymbolicLink(), false);
    if (process.platform !== 'win32') {
      assert.equal((await stat(loose)).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, 'attachments'))).mode & 0o777, 0o700);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const twoChildren = [
  { FirstName: 'Ada', LastName: 'Hansen', SchoolName: 'Nordpolen skole', UserName: 'ada01', SchoolCode: '1' },
  { FirstName: 'Ola', LastName: 'Hansen', SchoolName: 'Sagene skole', UserName: 'ola02', SchoolCode: '2' },
];

test('messages name their children and can be filtered by first or full name', async () => {
  const mobile = fakeMobile([
    message(3, { OnBehalfOf: 'ada01', OnBehalfOfList: ['ada01'] }),
    message(2, { OnBehalfOf: 'ola02', OnBehalfOfList: ['ola02'] }),
    message(1, { OnBehalfOf: 'ada01', OnBehalfOfList: ['ada01', 'ola02'] }),
  ], { children: twoChildren });
  const portal = new Portal({ mobile });
  assert.deepEqual(await portal.listChildren(), [
    { name: 'Ada Hansen', school: 'Nordpolen skole' }, { name: 'Ola Hansen', school: 'Sagene skole' },
  ]);
  const all = await portal.listMessages(30);
  assert.deepEqual(all.map(({ id, children }) => [id, children]), [
    ['3', ['Ada Hansen']], ['2', ['Ola Hansen']], ['1', ['Ada Hansen', 'Ola Hansen']],
  ]);
  assert.equal('recipients' in all[0], false);
  assert.deepEqual((await portal.listMessages(30, { child: 'ola' })).map(({ id }) => id), ['2', '1']);
  assert.deepEqual((await portal.listMessages(30, { child: ' Ada Hansen ' })).map(({ id }) => id), ['3', '1']);
  assert.deepEqual((await portal.getMessage('1')).children, ['Ada Hansen', 'Ola Hansen']);
  await assert.rejects(portal.listMessages(30, { child: 'Kari' }), /No child named "Kari".*Ada Hansen, Ola Hansen/);
  assert.equal(mobile.calls.children, 1, 'the child list is cached');
});

test('the child filter counts only matching messages towards the limit', async () => {
  const messages = inbox(40).map((item, index) => ({ ...item, OnBehalfOf: index % 2 ? 'ola02' : 'ada01' }));
  const mobile = fakeMobile(messages, { children: twoChildren });
  const listed = await new Portal({ mobile }).listMessages(10, { child: 'Ola' });
  assert.equal(listed.length, 10);
  assert.ok(listed.every(({ children }) => children[0] === 'Ola Hansen'));
  assert.equal(mobile.calls.pages.length, 2);
});

test('a child with a middle name matches the given name, all first names, or the full name', async () => {
  const children = [{ FirstName: 'Ada Marie', LastName: 'Hansen', SchoolName: 'X', UserName: 'ada01' }];
  const portal = new Portal({ mobile: fakeMobile([message(1, { OnBehalfOf: 'ada01' })], { children }) });
  for (const query of ['Ada', 'ada marie', 'Ada Hansen', 'ADA  MARIE HANSEN']) {
    assert.equal((await portal.listMessages(30, { child: query })).length, 1, query);
  }
  assert.deepEqual((await portal.listMessages(30))[0].children, ['Ada Marie Hansen']);
  await assert.rejects(portal.listMessages(30, { child: 'Marie' }), /No child named/);
});

test('an ambiguous first name asks for the full name', async () => {
  const children = [...twoChildren, { FirstName: 'Ada', LastName: 'Berg', SchoolName: 'X', UserName: 'ada03' }];
  const portal = new Portal({ mobile: fakeMobile([message(1)], { children }) });
  await assert.rejects(portal.listMessages(30, { child: 'ada' }), /more than one child/);
  assert.equal((await portal.listMessages(30, { child: 'Ada Berg' })).length, 0);
});

test('listing still works when the child list is unavailable', async () => {
  const portal = new Portal({ mobile: fakeMobile([message(1, { OnBehalfOf: 'ada01' })]) });
  assert.deepEqual((await portal.listMessages(30))[0].children, []);
  await assert.rejects(portal.listMessages(30, { child: 'Ada' }), /Child list unavailable/);
});
