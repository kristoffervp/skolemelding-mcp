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

// A fake Skolemelding: the web search returns these messages, the app search returns app (hidden ones only when asked),
// GET/POST are recorded, and the favourite and hide toggles flip the app message unless toggles is false.
function fake(messages, { postResult = true, after = {}, childExtra = {}, parents = [{ Name: 'Per Hansen' }], app = [], toggles = true, withoutHidden = false,
  postError, extraChildren = [] } = {}) {
  const calls = { get: [], post: [], search: [] };
  const flips = { '/api/message/ToggleMessageFavourite': 'IsFavourite', '/api/message/MarkMessageHidden': 'IsHidden' };
  let posted = false;
  const mobile = {
    calls,
    async getChildren() { return [{ ...child, ...childExtra }, ...extraChildren]; },
    async webSearchPage(page, pageSize) {
      const list = messages.map((m) => (posted ? { ...m, ...after } : m));
      return { Result: list.slice((page - 1) * pageSize, page * pageSize), TotalMatching: list.length };
    },
    async getJson(path) {
      calls.get.push(path);
      if (path.startsWith('/api/mychildsteachers')) return { Users: staff };
      if (path === '/Api/Settings') return { MaxRecipientsForParents: 2 };
      if (path.startsWith('/Api/Message/GetMessageWithId')) return [{ ThreadId: 't1', RecipientId: 'kl3a-thread', Replies: [] }];
      if (path === '/Api/MyProfile/GetChildsParent') return [{ UserName: 'ada01', LstParentInfo: parents }];
      throw new Error(`not stubbed: ${path}`);
    },
    async searchPage(page, pageSize, { unread = false, hidden = false } = {}) {
      calls.search.push({ page, unread, hidden });
      const list = app.filter((m) => (hidden || m.IsHidden !== true) && (!unread || m.IsMessageSeen === false))
        .map((m) => (withoutHidden ? { ...m, IsHidden: undefined } : m));
      return { Result: list.slice((page - 1) * pageSize, page * pageSize), TotalMatching: list.length };
    },
    async getText(path) { calls.get.push(path); return ''; },
    async postJson(path, body) {
      calls.post.push({ path, body });
      if (postError) throw postError;
      posted = true;
      const flipped = toggles && flips[path] && app.find((m) => m.Id === body.id && m.OnBehalfOf === body.onBehalfOf);
      if (flipped) flipped[flips[path]] = !flipped[flips[path]];
      return postResult;
    },
  };
  return mobile;
}

async function setup(messages, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'skolemelding-send-'));
  const mobile = fake(messages, options);
  let now = Date.parse('2026-11-25T10:00:00Z');
  const sender = new Sender({ mobile, portal: new Portal({ mobile }), log: join(dir, 'sent.jsonl'), now: () => now, confirm: options.confirm });
  return { mobile, sender, dir, log: join(dir, 'sent.jsonl'), later: (ms) => { now += ms; } };
}

test('a reply is prepared without sending, then sent once with the code, in the existing thread', async (t) => {
  const { mobile, sender, dir, log } = await setup([message(7, { Threads: [{ ThreadId: 't1', DisplayText: 'Kari Lærer' }] })]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await sender.prepareReply({ message_id: '007', text: 'Mormor henter på fredag.\n\nHilsen Per' });
  assert.equal(mobile.calls.post.length, 0, 'prepare sends nothing');
  assert.deepEqual({ ...prepared, confirmationCode: undefined, note: undefined }, { action: 'reply', messageId: '7', subject: 'Subject 7',
    from: 'Kari Lærer', children: ['Ada Hansen'], to: ['Kari Lærer'], inThread: true, text: 'Mormor henter på fredag.\n\nHilsen Per',
    summary: 'reply · Ada Hansen · to Kari Lærer · Subject 7 · «Mormor henter på fredag. Hilsen Per»',
    confirmationCode: undefined, expiresInMinutes: 10, note: undefined });
  const sent = await sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
  assert.equal(sent.sent, true);
  assert.deepEqual(mobile.calls.post, [{ path: '/api/ThreadMessage', body: { MessageId: 7, MessageText: 'Mormor henter på fredag.\n\nHilsen Per',
    OnBehalfOf: 'ada01', RecipientId: 'kl3a-thread', ThreadId: 't1', AddOtherParentInThread: false, AddOtherTeacherInThread: false, TeacherRecipients: [] } }]);
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /Unknown or expired/);
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
  await sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
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
  const sent = await sender.sendPrepared({ confirmation_code: answer.confirmationCode, summary: answer.summary });
  assert.equal(sent.verified, true);
  assert.deepEqual(mobile.calls.post[0], { path: '/Api/message/ConfirmFeedbackWithPossibleQuestion',
    body: { FeedbackGiven: 'Ja', Id: 20, MessageConfirmed: true, OnBehalfOf: 'ada01' } });
  await assert.rejects(sender.prepareAnswer({ message_id: '23', answer: 'nei' }), /no yes\/no question/);
  const read = await sender.prepareReadConfirmation({ message_id: '22' });
  const confirmed = await sender.sendPrepared({ confirmation_code: read.confirmationCode, summary: read.summary });   // IsMessageConfirmed stays false in this fake
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
  await sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
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
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /expired/);
  assert.equal(mobile.calls.post.length, 0);
});

test('the other parent gets a copy only when the reply starts a new thread and the school allows it', async (t) => {
  const { mobile, sender, dir } = await setup([message(40, { CanAddOtherParents: true }),
    message(41, { CanAddOtherParents: true, Threads: [{ ThreadId: 't1', DisplayText: 'Kari Lærer' }] }), message(42, { CanAddOtherParents: false })]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await sender.prepareReply({ message_id: '40', text: 'Takk!', include_other_parents: true });
  assert.deepEqual([prepared.to, prepared.copyTo, prepared.inThread], [['Kari Lærer'], ['Per Hansen'], false]);
  await sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
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
  await sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
  assert.deepEqual(mobile.calls.post, [{ path: '/Api/message/', body: { Attachments: [], Body: 'Elev: Ada Hansen \n Tidspunkt for fravær: 26.11.2026 kl. 08:00 til 11:30',
    ExistingFileIds: [], FeedbackQuestionRequired: false, FeedbackRequired: false, GroupRecipients: [], Header: 'Melding om fravær',
    IsAbsenceReport: true, IsCreatedOnWeb: true, IsReplyAllowed: true, IsSmsMessage: false, SmsNotification: false, UserRecipients: [],
    OnBehalfOf: 'ada01', SchoolId: 'NPS', IsOtherUserAdded: true, IsSpecialMessage: false, HideReceivers: false } }]);
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

test('an absence report is refused when no teacher is connected, and a copy needs another parent', async (t) => {
  const none = await setup([], { childExtra: { DependentHasTeacherConnectedPerSchool: [{ SchoolCode: 'NPS', HasTeacherConnected: false }] } });
  t.after(() => rm(none.dir, { recursive: true, force: true }));
  await assert.rejects(none.sender.prepareAbsence({ when: 'today' }), /no recipients/);
  const alone = await setup([], { parents: [] });
  t.after(() => rm(alone.dir, { recursive: true, force: true }));
  await assert.rejects(alone.sender.prepareMessage({ recipients: ['kl3a'], subject: 'Hei', text: 'Tekst', include_other_parents: true }), /No other parent/);
  const connected = await setup([], { childExtra: { DependentHasTeacherConnectedPerSchool: [{ SchoolCode: 'NPS', HasTeacherConnected: true }] } });
  t.after(() => rm(connected.dir, { recursive: true, force: true }));
  assert.equal((await connected.sender.prepareAbsence({ when: 'today' })).subject, 'Melding om fravær');
});

test('mark_read marks the message and its unread replies, and sends nothing else', async (t) => {
  const { mobile, sender, dir } = await setup([message(50, { Threads: [{ ThreadId: 't 1', IsSeen: false }, { ThreadId: 't2', IsSeen: true }] })]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await sender.markRead({ message_id: '50' });
  assert.deepEqual([result.markedRead, result.threads, result.subject], [true, 1, 'Subject 50']);
  assert.deepEqual(mobile.calls.get.filter((path) => path.includes('MarkMessageRead')), [
    '/api/message/MarkMessageRead?messageId=50&threadid=&onBehalfOf=ada01',
    '/api/message/MarkMessageRead?messageId=50&threadid=t%201&onBehalfOf=ada01']);
  assert.equal(mobile.calls.post.length, 0);
  assert.match(await readFile(join(dir, 'sent.jsonl'), 'utf8'), /"action":"mark_read".*"messageId":"50"/);
  await assert.rejects(sender.markRead({ message_id: '../1' }), /Invalid message ID/);
});

test('hidden characters and variation-selector runs are removed from previews', async () => {
  const { clean } = await import('../src/portal.js');
  assert.equal(clean('A\u3164B\u2800C\u{E0100}D\u034F'), 'ABCD');
  assert.equal(clean('❤\uFE0F\uFE0F\uFE0F'), '❤\uFE0F');
  assert.equal(clean('a\u2028b'), 'a\nb');
});

test('the parent confirms in the dialog: a no sends nothing and uses up the code', async (t) => {
  const questions = [];
  const { mobile, sender, dir } = await setup([message(60)], { confirm: async (text) => { questions.push(text); return false; } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await sender.prepareReply({ message_id: '60', text: 'Hei' });
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /not confirmed/);
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /Unknown or expired/);
  await assert.rejects(sender.markRead({ message_id: '60' }), /not confirmed/);
  assert.equal(mobile.calls.post.length, 0);
  assert.equal(mobile.calls.get.some((path) => path.includes('MarkMessageRead')), false);
  assert.match(questions[0], /^Skolemelding: reply\n.*\n\nText that is sent:\nHei$/s);
});

test('send_prepared needs the summary exactly as prepared', async (t) => {
  const { mobile, sender, dir } = await setup([message(70)]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await sender.prepareReply({ message_id: '70', text: 'Ada kommer   ikke\nHilsen Per' });
  assert.equal(prepared.summary, 'reply · Ada Hansen · to Kari Lærer · Subject 70 · «Ada kommer ikke Hilsen Per»');
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode }), /summary does not match/);
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: 'reply' }), /summary does not match/);
  assert.equal(mobile.calls.post.length, 0);
  await sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
  assert.equal(mobile.calls.post.length, 1);
});

test('set_favourite reads the state first: no call when it already matches, one toggle when it does not, then verifies', async (t) => {
  const app = [message(80, { IsFavourite: true }), message(81, { IsFavourite: false }), message(82)];
  const questions = [];
  const { mobile, sender, dir, log } = await setup([], { app, confirm: async (text) => { questions.push(text); return true; } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const same = await sender.setFavourite({ message_id: '80', favourite: true });
  assert.deepEqual([same.changed, same.favourite, mobile.calls.post.length, questions.length], [false, true, 0, 0]);
  const changed = await sender.setFavourite({ message_id: '081', favourite: true });
  assert.deepEqual([changed.changed, changed.verified, changed.subject], [true, true, 'Subject 81']);
  assert.deepEqual(mobile.calls.post, [{ path: '/api/message/ToggleMessageFavourite', body: { id: 81, onBehalfOf: 'ada01' } }]);
  assert.match(questions[0], /^Skolemelding: set_favourite\n[\s\S]*favourite: true/);
  assert.match(await readFile(log, 'utf8'), /"action":"set_favourite".*"messageId":"81"/);
  await assert.rejects(sender.setFavourite({ message_id: '82', favourite: true }), /Could not read whether/, 'unknown state is not toggled');
  await assert.rejects(sender.setFavourite({ message_id: '80', favourite: 'yes' }), /true or false/);
  await assert.rejects(sender.setFavourite({ message_id: '8 0', favourite: true }), /Invalid message ID/);
  assert.equal(mobile.calls.post.length, 1);
});

test('two set_favourite calls at once toggle only once', async (t) => {
  const app = [message(83, { IsFavourite: false })];
  const { mobile, sender, dir } = await setup([], { app });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const results = await Promise.all([sender.setFavourite({ message_id: '83', favourite: true }), sender.setFavourite({ message_id: '83', favourite: true })]);
  assert.deepEqual(results.map((r) => r.changed), [true, false]);
  assert.equal(mobile.calls.post.length, 1);
  assert.equal(app[0].IsFavourite, true);
});

test('set_hidden finds hidden messages too, toggles only when needed, and refuses when the state is unclear', async (t) => {
  const app = [message(90), message(91, { IsHidden: true })];
  const { mobile, sender, dir } = await setup([], { app });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hidden = await sender.setHidden({ message_id: '90', hidden: true });
  assert.deepEqual([hidden.changed, hidden.verified], [true, true], 'a message in the plain inbox is not hidden, even without IsHidden');
  assert.deepEqual(mobile.calls.post.at(-1), { path: '/api/message/MarkMessageHidden', body: { id: 90, onBehalfOf: 'ada01' } });
  assert.equal((await sender.setHidden({ message_id: '91', hidden: true })).changed, false);
  const shown = await sender.setHidden({ message_id: '91', hidden: false });
  assert.deepEqual([shown.changed, shown.hidden, shown.verified], [true, false, true]);
  assert.equal(mobile.calls.post.length, 2);
  await assert.rejects(sender.setHidden({ message_id: '404', hidden: true }), /not found/);
  assert.equal(mobile.calls.post.length, 2);
  // Only in the search that includes hidden messages, but the response does not say it is hidden.
  const unclear = await setup([], { app: [message(92, { IsHidden: true })], withoutHidden: true });
  t.after(() => rm(unclear.dir, { recursive: true, force: true }));
  await assert.rejects(unclear.sender.setHidden({ message_id: '92', hidden: false }), /Could not read whether this message is hidden/);
  assert.equal(unclear.mobile.calls.post.length, 0);
});

test('a toggle the parent declines sends nothing, and one that does not show afterwards says so', async (t) => {
  const declined = await setup([], { app: [message(93, { IsFavourite: false })], confirm: async () => false });
  t.after(() => rm(declined.dir, { recursive: true, force: true }));
  await assert.rejects(declined.sender.setFavourite({ message_id: '93', favourite: true }), /not confirmed/);
  assert.equal(declined.mobile.calls.post.length, 0);
  const stuck = await setup([], { app: [message(94, { IsFavourite: false })], toggles: false });
  t.after(() => rm(stuck.dir, { recursive: true, force: true }));
  const result = await stuck.sender.setFavourite({ message_id: '94', favourite: true });
  assert.deepEqual([result.changed, result.verified], [true, false]);
  assert.match(result.note, /does not show it yet/);
  const refused = await setup([], { app: [message(95, { IsHidden: false })], postResult: false });
  t.after(() => rm(refused.dir, { recursive: true, force: true }));
  await assert.rejects(refused.sender.setHidden({ message_id: '95', hidden: true }), /did not accept/);
});

test('mark all read is prepared with the unread count for the child, and sent once with send_prepared', async (t) => {
  const app = [message(100, { IsMessageSeen: false }), message(101, { IsMessageSeen: false }), message(102, { IsMessageSeen: true }),
    message(103, { IsMessageSeen: false, OnBehalfOf: 'bob02' })];
  const { mobile, sender, dir } = await setup([], { app });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await sender.prepareMarkAllRead();
  assert.deepEqual([prepared.action, prepared.child, prepared.unreadMessages, prepared.summary],
    ['mark_all_read', 'Ada Hansen', 2, 'mark_all_read · Ada Hansen · 2 unread messages']);
  assert.equal(mobile.calls.post.length, 0, 'prepare sends nothing');
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: 'mark_all_read · Ada Hansen' }), /summary does not match/);
  const sent = await sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
  assert.deepEqual([sent.sent, sent.unreadMessages], [true, 2]);
  assert.deepEqual(mobile.calls.post, [{ path: '/api/Message/sync-unread', body: { OnBehalfOn: 'ada01' } }]);
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /Unknown or expired/);
  const none = await setup([], { app: [message(104, { IsMessageSeen: true })] });
  t.after(() => rm(none.dir, { recursive: true, force: true }));
  await assert.rejects(none.sender.prepareMarkAllRead({ child: 'Ada' }), /No unread messages for Ada Hansen/);
  await assert.rejects(none.sender.prepareMarkAllRead({ child: 'Bob' }), /No child named/);
});

test('the dialog cannot be faked by line breaks in a subject: one short line per value, the decision first, sent text last', async (t) => {
  const questions = [];
  const header = `Info\nhidden: false favourite: true${'\n'.repeat(4000)}end`;
  const { mobile, sender, dir } = await setup([message(110, { Header: header })], { app: [message(110, { Header: header })],
    confirm: async (text) => { questions.push(text); return false; } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(sender.setHidden({ message_id: '110', hidden: true }), /not confirmed/);
  const lines = questions[0].split('\n');
  assert.equal(lines[1], 'hidden: true', 'the deciding field comes first');
  assert.equal(lines.filter((line) => /^(hidden|favourite):/.test(line)).length, 1, 'no injected field lines');
  assert.ok(lines.every((line) => line.length <= 220));
  const reply = await sender.prepareReply({ message_id: '110', text: 'Hei\nanswer: Nei' });
  assert.equal(reply.summary.includes('\n'), false, 'the summary is one line');
  await assert.rejects(sender.sendPrepared({ confirmation_code: reply.confirmationCode, summary: reply.summary }), /not confirmed/);
  assert.match(questions[1], /\n\nText that is sent:\nHei\nanswer: Nei$/, 'the sent text comes last, under its own heading');
  assert.equal(mobile.calls.post.length, 0);
});

test('after a toggle that does not show yet, the message is not toggled again for five minutes', async (t) => {
  const { mobile, sender, dir, later } = await setup([], { app: [message(111, { IsFavourite: false })], toggles: false });
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await sender.setFavourite({ message_id: '111', favourite: true })).verified, false);
  await assert.rejects(sender.setFavourite({ message_id: '111', favourite: true }), /does not show yet/);
  await assert.rejects(sender.setFavourite({ message_id: '111', favourite: false }), /does not show yet/);
  assert.equal(mobile.calls.post.length, 1, 'a retry cannot flip it back');
  later(5 * 60_000);
  await sender.setFavourite({ message_id: '111', favourite: true });
  assert.equal(mobile.calls.post.length, 2);
});

test('a toggle with no clear answer is logged and blocks a retry', async (t) => {
  const { PublicError } = await import('../src/errors.js');
  const { mobile, sender, dir, log } = await setup([], { app: [message(112, { IsHidden: false })],
    postError: new PublicError('No answer from Skolemelding. It may have been sent: check in the Skolemelding app before you try again.') });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(sender.setHidden({ message_id: '112', hidden: true }), /may have been sent/);
  assert.match(await readFile(log, 'utf8'), /"action":"set_hidden","hidden":true.*"failed":true.*may have been sent/);
  await assert.rejects(sender.setHidden({ message_id: '112', hidden: true }), /does not show yet/);
  assert.equal(mobile.calls.post.length, 1);
  const send = await setup([message(113)], { postError: new PublicError('Skolemelding request failed (HTTP 500).') });
  t.after(() => rm(send.dir, { recursive: true, force: true }));
  const prepared = await send.sender.prepareReply({ message_id: '113', text: 'Hei' });
  await assert.rejects(send.sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /HTTP 500/);
  assert.match(await readFile(send.log, 'utf8'), /"action":"reply".*"failed":true/);
});

test('a message about two children is toggled only for the chosen child, and verified on that copy', async (t) => {
  const app = [message(114, { IsHidden: true }), message(114, { OnBehalfOf: 'bob02' })];
  const { mobile, sender, dir } = await setup([], { app,
    extraChildren: [{ FirstName: 'Bob', LastName: 'Hansen', SchoolName: 'Nordpolen skole', UserName: 'bob02', SchoolCode: 'NPS' }] });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(sender.setHidden({ message_id: '114', hidden: false }), /several children \(Bob Hansen, Ada Hansen\).*child/);
  const shown = await sender.setHidden({ message_id: '114', hidden: false, child: 'Ada' });
  assert.deepEqual([shown.changed, shown.verified, shown.children], [true, true, ['Ada Hansen']]);
  assert.deepEqual(mobile.calls.post, [{ path: '/api/message/MarkMessageHidden', body: { id: 114, onBehalfOf: 'ada01' } }]);
  assert.equal((await sender.setHidden({ message_id: '114', hidden: false, child: 'Bob' })).changed, false);
  const hidden = await sender.setHidden({ message_id: '114', hidden: true, child: 'Bob' });
  assert.deepEqual([hidden.verified, app[0].IsHidden, app[1].IsHidden], [true, false, true]);
});

test('a change made while the dialog is open is not undone', async (t) => {
  const app = [message(115, { IsHidden: false })];
  const { mobile, sender, dir } = await setup([], { app, confirm: async () => { app[0].IsHidden = true; return true; } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await sender.setHidden({ message_id: '115', hidden: true });
  assert.deepEqual([result.changed, app[0].IsHidden, mobile.calls.post.length], [false, true, 0]);
  assert.match(result.note, /already changed while waiting/);
});

test('the mark-all-read dialog says it cannot be undone and shows 100+ at the cap', async (t) => {
  const questions = [];
  const app = Array.from({ length: 105 }, (_, i) => message(200 + i, { IsMessageSeen: false }));
  const { sender, dir } = await setup([], { app, confirm: async (text) => { questions.push(text); return false; } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await sender.prepareMarkAllRead();
  assert.match(prepared.summary, /100\+ unread messages/);
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /not confirmed/);
  assert.match(questions[0].split('\n')[1], /^effect: Marks all 100\+ unread messages about Ada Hansen as read, and any that arrive before it is sent\. It can't be undone\.$/);
});
