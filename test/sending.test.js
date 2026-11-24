import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Portal } from '../src/portal.js';
import { Sender, absenceTime } from '../src/sending.js';

const child = { FirstName: 'Ada', LastName: 'Hansen', SchoolName: 'Nordpolen skole', UserName: 'ada01', SchoolCode: 'NPS' };
const staff = [
  { IsMine: false, Username: 'rektor1', FullName: 'Rita Rektor', Email: 'r@example.org', Groups: [] },
  { IsMine: true, Username: 'kl3a', FullName: 'Kari Lærer', Email: 'k@example.org', Groups: [{ FullName: '3A KL', Description: '' }] },
];

function message(id, extra = {}) {
  return { Id: id, Header: `Subject ${id}`, From: 'Kari Lærer', Author: 'kl3a', OnBehalfOf: 'ada01', IsReplyAllowed: true,
    Threads: [], FeedbackGiven: null, IsMessageConfirmed: false, ...extra };
}

// A fake Skolemelding: the web search returns these messages, GET/POST are recorded.
function fake(messages, { postResult = true, after = {} } = {}) {
  const calls = { get: [], post: [] };
  let posted = false;
  const mobile = {
    calls,
    async getChildren() { return [child]; },
    async webSearchPage(page, pageSize) {
      const list = messages.map((m) => (posted ? { ...m, ...after } : m));
      return { Result: list.slice((page - 1) * pageSize, page * pageSize), TotalMatching: list.length };
    },
    async getJson(path) {
      calls.get.push(path);
      if (path.startsWith('/api/mychildsteachers')) return { Users: staff };
      if (path === '/Api/Settings') return { MaxRecipientsForParents: 2 };
      if (path.startsWith('/Api/Message/GetMessageWithId')) return [{ ThreadId: 't1', RecipientId: 'kl3a-thread', Replies: [] }];
      if (path === '/Api/MyProfile/GetChildsParent') return [{ UserName: 'ada01', LstParentInfo: [{ Name: 'Per Hansen' }] }];
      throw new Error(`not stubbed: ${path}`);
    },
    async postJson(path, body) { calls.post.push({ path, body }); posted = true; return postResult; },
  };
  return mobile;
}

async function setup(messages, options) {
  const dir = await mkdtemp(join(tmpdir(), 'skolemelding-send-'));
  const mobile = fake(messages, options);
  let now = Date.parse('2026-11-25T10:00:00Z');
  const sender = new Sender({ mobile, portal: new Portal({ mobile }), log: join(dir, 'sent.jsonl'), now: () => now });
  return { mobile, sender, dir, log: join(dir, 'sent.jsonl'), later: (ms) => { now += ms; } };
}

test('a reply is prepared without sending, then sent once with the code, in the existing thread', async (t) => {
  const { mobile, sender, dir, log } = await setup([message(7, { Threads: [{ ThreadId: 't1', DisplayText: 'Kari Lærer' }] })]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await sender.prepareReply({ message_id: '007', text: 'Mormor henter på fredag.\n\nHilsen Per' });
  assert.equal(mobile.calls.post.length, 0, 'prepare sends nothing');
  assert.deepEqual({ ...prepared, confirmationCode: undefined, note: undefined }, { action: 'reply', messageId: '7', subject: 'Subject 7',
    from: 'Kari Lærer', children: ['Ada Hansen'], to: ['Kari Lærer'], inThread: true, text: 'Mormor henter på fredag.\n\nHilsen Per',
    confirmationCode: undefined, expiresInMinutes: 10, note: undefined });
  const sent = await sender.sendPrepared({ confirmation_code: prepared.confirmationCode });
  assert.equal(sent.sent, true);
  assert.deepEqual(mobile.calls.post, [{ path: '/api/ThreadMessage', body: { MessageId: 7, MessageText: 'Mormor henter på fredag.\n\nHilsen Per',
    OnBehalfOf: 'ada01', RecipientId: 'kl3a-thread', ThreadId: 't1', AddOtherParentInThread: false, AddOtherTeacherInThread: false, TeacherRecipients: [] } }]);
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode }), /Unknown or expired/);
  assert.equal(mobile.calls.post.length, 1, 'the code works only once');
  const logged = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].text, 'Mormor henter på fredag.\n\nHilsen Per');
});

test('without a thread the reply starts one to the author; several threads need thread_id', async (t) => {
  const { mobile, sender, dir } = await setup([message(8), message(9, { Threads: [{ ThreadId: 'a', DisplayText: 'X' }, { ThreadId: 'b', DisplayText: 'Y' }] })]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await sender.prepareReply({ message_id: '8', text: 'Takk!' });
  assert.equal(prepared.inThread, false);
  await sender.sendPrepared({ confirmation_code: prepared.confirmationCode });
  assert.equal(mobile.calls.post[0].body.RecipientId, 'kl3a');
  assert.equal(mobile.calls.post[0].body.ThreadId, '');
  await assert.rejects(sender.prepareReply({ message_id: '9', text: 'Hei' }), /several threads.*a \(X\), b \(Y\)/);
  await assert.rejects(sender.prepareReply({ message_id: '9', text: 'Hei', thread_id: 'c' }), /No thread/);
});

test('invalid input is refused before Skolemelding is asked, and replies the school turned off are refused', async (t) => {
  const { mobile, sender, dir } = await setup([message(10, { IsReplyAllowed: false })]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(sender.prepareReply({ message_id: '10', text: '   ' }), /non-empty/);
  await assert.rejects(sender.prepareReply({ message_id: '10', text: 'x'.repeat(5001) }), /at most 5000/);
  await assert.rejects(sender.prepareAnswer({ message_id: '10', answer: 'kanskje' }), /ja.*nei/);
  await assert.rejects(sender.prepareReply({ message_id: '1x', text: 'Hei' }), /Invalid message ID/);
  assert.equal(mobile.calls.get.length, 0);
  await assert.rejects(sender.prepareReply({ message_id: '10', text: 'Hei' }), /turned off replies/);
  await assert.rejects(sender.prepareReply({ message_id: '404', text: 'Hei' }), /not found/);
});

test('yes/no answers and read confirmations are checked against the message and verified afterwards', async (t) => {
  const messages = [message(20, { IsFeedBackQuestion: true, QuestionText: '<p>Kan Ada være med?</p>' }), message(21, { IsFeedBackQuestion: true, FeedbackGiven: 'Nei' }),
    message(22, { IsFeedBackReadConfirmation: true }), message(23)];
  const { mobile, sender, dir } = await setup(messages, { after: { FeedbackGiven: 'Ja' } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const answer = await sender.prepareAnswer({ message_id: '20', answer: 'ja' });
  assert.equal(answer.question, 'Kan Ada være med?');
  const sent = await sender.sendPrepared({ confirmation_code: answer.confirmationCode });
  assert.equal(sent.verified, true);
  assert.deepEqual(mobile.calls.post[0], { path: '/Api/message/ConfirmFeedbackWithPossibleQuestion',
    body: { FeedbackGiven: 'Ja', Id: 20, MessageConfirmed: true, OnBehalfOf: 'ada01' } });
  await assert.rejects(sender.prepareAnswer({ message_id: '23', answer: 'nei' }), /no yes\/no question/);
  const read = await sender.prepareReadConfirmation({ message_id: '22' });
  const confirmed = await sender.sendPrepared({ confirmation_code: read.confirmationCode });   // IsMessageConfirmed stays false in this fake
  assert.equal(confirmed.verified, false);
  assert.match(confirmed.note, /does not show it yet/);
  await assert.rejects(sender.prepareReadConfirmation({ message_id: '23' }), /not asked for a read confirmation/);
});

test('an answered question is refused', async (t) => {
  const { sender, dir } = await setup([message(21, { IsFeedBackQuestion: true, FeedbackGiven: 'Nei' })]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(sender.prepareAnswer({ message_id: '21', answer: 'ja' }), /already answered \(Nei\)/);
});

test('a new message goes only to staff from list_recipients, within the limit, as escaped HTML', async (t) => {
  const { mobile, sender, dir } = await setup([]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { recipients } = await sender.listRecipients();
  assert.deepEqual(recipients.map((r) => [r.username, r.childsTeacher]), [['kl3a', true], ['rektor1', false]]);
  await assert.rejects(sender.prepareMessage({ recipients: ['ukjent'], subject: 'Hei', text: 'Tekst' }), /Not a recipient/);
  await assert.rejects(sender.prepareMessage({ recipients: ['kl3a', 'rektor1', 'x'], subject: 'Hei', text: 'Tekst' }), /at most 2/);
  const prepared = await sender.prepareMessage({ recipients: ['kl3a'], subject: 'Fravær fredag', text: 'Ada er hos tannlegen <kl 10>.\nHilsen Per' });
  assert.deepEqual(prepared.to, ['Kari Lærer']);
  await sender.sendPrepared({ confirmation_code: prepared.confirmationCode });
  const { path, body } = mobile.calls.post[0];
  assert.equal(path, '/Api/message/');
  assert.equal(body.Body, '<p>Ada er hos tannlegen &lt;kl 10&gt;.<br />Hilsen Per</p>');
  assert.equal(body.OnBehalfOf, 'ada01');
  assert.deepEqual(body.UserRecipients, [staff[1]]);
  assert.equal(body.IsOtherUserAdded, false);
});

test('codes expire after ten minutes', async (t) => {
  const { mobile, sender, dir, later } = await setup([message(30)]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await sender.prepareReply({ message_id: '30', text: 'Hei' });
  later(10 * 60_000 + 1);
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode }), /expired/);
  assert.equal(mobile.calls.post.length, 0);
});

test('the other parent gets a copy only when the reply starts a new thread and the school allows it', async (t) => {
  const { mobile, sender, dir } = await setup([message(40, { CanAddOtherParents: true }),
    message(41, { CanAddOtherParents: true, Threads: [{ ThreadId: 't1', DisplayText: 'Kari Lærer' }] }), message(42, { CanAddOtherParents: false })]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await sender.prepareReply({ message_id: '40', text: 'Takk!', include_other_parents: true });
  assert.deepEqual([prepared.to, prepared.copyTo, prepared.inThread], [['Kari Lærer'], ['Per Hansen'], false]);
  await sender.sendPrepared({ confirmation_code: prepared.confirmationCode });
  assert.equal(mobile.calls.post[0].body.AddOtherParentInThread, true);
  assert.equal(mobile.calls.post[0].body.ThreadId, '');
  await assert.rejects(sender.prepareReply({ message_id: '41', text: 'Takk!', include_other_parents: true }), /new thread/);
  await assert.rejects(sender.prepareReply({ message_id: '42', text: 'Takk!', include_other_parents: true }), /does not allow/);
  const plain = await sender.prepareReply({ message_id: '42', text: 'Takk!' });
  assert.equal('copyTo' in plain, false);
});

test('an absence report has the same text and fields as the app form, and goes only with send_prepared', async (t) => {
  const { mobile, sender, dir } = await setup([]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await sender.prepareAbsence({ when: 'dates', from_date: '2026-11-26', from_time: '08:00', to_time: '11:30', include_other_parents: true });
  assert.deepEqual([prepared.action, prepared.child, prepared.absence, prepared.copyTo], ['absence', 'Ada Hansen', '26.11.2026 kl. 08:00 til 11:30', ['Per Hansen']]);
  assert.equal(mobile.calls.post.length, 0);
  await sender.sendPrepared({ confirmation_code: prepared.confirmationCode });
  assert.deepEqual(mobile.calls.post, [{ path: '/Api/message/', body: { Body: 'Elev: Ada Hansen \n Tidspunkt for fravær: 26.11.2026 kl. 08:00 til 11:30',
    IsAbsenceReport: true, IsCreatedOnWeb: true, IsReplyAllowed: true, OnBehalfOf: 'ada01', SchoolId: 'NPS', IsOtherUserAdded: true,
    IsSpecialMessage: false, HideReceivers: false } }]);
  await assert.rejects(sender.prepareAbsence({ when: 'yesterday' }), /today.*tomorrow.*dates/);
});

test('absence times follow the app: whole days, date ranges, and times on one or several days', () => {
  const now = Date.parse('2026-11-24T23:30:00Z');   // 00:30 on 25 November in Oslo
  assert.equal(absenceTime({ when: 'today' }, now), '25.11.2026 (Hel dag)');
  assert.equal(absenceTime({ when: 'tomorrow' }, now), '26.11.2026 (Hel dag)');
  assert.equal(absenceTime({ when: 'tomorrow' }, Date.parse('2026-10-24T22:30:00Z')), '26.10.2026 (Hel dag)', 'the night the clocks go back');
  assert.equal(absenceTime({ when: 'dates', from_date: '2026-11-26', to_date: '2026-11-27' }, now), '26.11.2026 til 27.11.2026');
  assert.equal(absenceTime({ when: 'dates', from_date: '2026-11-26' }, now), '26.11.2026 til 26.11.2026');
  assert.equal(absenceTime({ when: 'dates', from_date: '2026-11-26', to_date: '2026-11-27', from_time: '12:00', to_time: '10:00' }, now),
    '26.11.2026 kl. 12:00 til 27.11.2026 kl. 10:00');
  for (const [args, why] of [[{ when: 'dates', from_date: '2026-10-01' }, /a month back/], [{ when: 'dates', from_date: '2026-11-26', from_time: '08:00' }, /both/],
    [{ when: 'dates', from_date: '2026-11-26', from_time: '12:00', to_time: '10:00' }, /end before/], [{ when: 'dates', from_date: '2026-11-27', to_date: '2026-11-26' }, /before from_date/],
    [{ when: 'today', from_date: '2026-11-26' }, /only used with/], [{ when: 'dates', from_date: '2026-02-30' }, /date like/],
    [{ when: 'dates', from_date: '2026-11-26', from_time: '24:00', to_time: '25:00' }, /time like/]]) {
    assert.throws(() => absenceTime(args, now), why, JSON.stringify(args));
  }
});
