import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sentLogPath } from './browser.js';
import { PublicError } from './errors.js';
import { clean, plainText } from './portal.js';

// Sending is off unless SKOLEMELDING_ALLOW_SEND=1. Everything is sent in two steps: a prepare tool checks the
// message and returns exactly what will be sent with a one-time code, and send_prepared sends only that.
// The endpoints are the ones the Skoleplattform web portal uses (see README, "Sending").
export const sendingEnabled = () => process.env.SKOLEMELDING_ALLOW_SEND === '1';

const codeTtl = 10 * 60_000;
const maxPending = 20;
const maxText = 5_000;
const maxSubject = 200;
const pageSize = 15;
const maxPages = 20;

function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new PublicError(`${name} must be non-empty text.`);
  const cleaned = clean(value).replace(/\r\n?/g, '\n').trim();
  if (cleaned.length > max) throw new PublicError(`${name} can be at most ${max} characters.`);
  return cleaned;
}

function messageId(id) {
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new PublicError('Invalid message ID.');
  return id.replace(/^0+(?=\d)/, '');
}

// Dates as the school sees them: the calendar day in Oslo, written dd.mm.yyyy like the web portal.
function osloDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' }).format(ms);
}
function norwegian(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}
function isoDate(value, name) {
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : null;
  if (!date || date.toISOString().slice(0, 10) !== value) throw new PublicError(`${name} must be a date like 2026-11-30.`);
  return value;
}
function time(value, name) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new PublicError(`${name} must be a time like 08:00.`);
  return value;
}

// The text the web portal's "Melding om fravær" form sends: today/tomorrow as whole days, or dates with optional times.
export function absenceTime({ when, from_date: fromDate, to_date: toDate, from_time: fromTime, to_time: toTime }, now) {
  if (when === 'today' || when === 'tomorrow') {
    if ([fromDate, toDate, fromTime, toTime].some((v) => v !== undefined)) throw new PublicError(`Dates and times are only used with when: "dates".`);
    const today = osloDate(now);
    // Tomorrow from the calendar day, not now + 24 h, which lands on the same day just after midnight when the clocks go back.
    const day = when === 'tomorrow' ? new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : today;
    return `${norwegian(day)} (Hel dag)`;
  }
  if (when !== 'dates') throw new PublicError('when must be "today", "tomorrow" or "dates".');
  const from = isoDate(fromDate, 'from_date');
  const to = toDate === undefined ? from : isoDate(toDate, 'to_date');
  if ((fromTime === undefined) !== (toTime === undefined)) throw new PublicError('Give both from_time and to_time, or neither.');
  const earliest = osloDate(new Date(now).setMonth(new Date(now).getMonth() - 1));
  if (from < earliest) throw new PublicError(`The absence can start at most a month back (${norwegian(earliest)}).`);
  if (fromTime === undefined) {
    if (to < from) throw new PublicError('to_date cannot be before from_date.');
    return `${norwegian(from)} til ${norwegian(to)}`;
  }
  const [start, end] = [time(fromTime, 'from_time'), time(toTime, 'to_time')];
  if (`${to}T${end}` < `${from}T${start}`) throw new PublicError('The absence cannot end before it starts.');
  return from === to ? `${norwegian(from)} kl. ${start} til ${end}` : `${norwegian(from)} kl. ${start} til ${norwegian(to)} kl. ${end}`;
}

// The web portal's editor sends HTML; plain text is escaped and line breaks are kept.
function html(value) {
  const escaped = value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return escaped.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br />')}</p>`).join('');
}

export class Sender {
  #mobile;
  #portal;
  #log;
  #now;
  #pending = new Map();

  constructor({ mobile, portal, log = sentLogPath, now = Date.now }) {
    this.#mobile = mobile;
    this.#portal = portal;
    this.#log = log;
    this.#now = now;
  }

  // Finds a received (or, with sent, a sent) message by ID through the web search, which has the fields sending needs.
  async #message(id, { sent = false } = {}) {
    for (let page = 1; page <= maxPages; page++) {
      const { Result, TotalMatching } = await this.#mobile.webSearchPage(page, pageSize, { sent });
      const found = Result.find((message) => String(message.Id) === id);
      if (found) return found;
      if (page * pageSize >= Number(TotalMatching) || Result.length < pageSize) break;
    }
    throw new PublicError('Message not found among the newest messages.');
  }

  // Names of the child's other guardians, who can read the thread or message when include_other_parents is set.
  async #otherParents(childUserName) {
    const data = await this.#mobile.getJson('/Api/MyProfile/GetChildsParent');
    const entry = (Array.isArray(data) ? data : []).find((c) => c?.UserName === childUserName);
    return (Array.isArray(entry?.LstParentInfo) ? entry.LstParentInfo : []).map((p) => clean(p?.Name)).filter(Boolean);
  }

  async #describe(message) {
    const children = await this.#portal.childNames([message.OnBehalfOf].filter(Boolean));
    return { messageId: String(message.Id), subject: clean(message.Header), from: clean(message.From), children };
  }

  #prepare(action, request, preview, verify) {
    const now = this.#now();
    for (const [code, entry] of this.#pending) if (entry.expiresAt <= now) this.#pending.delete(code);
    if (this.#pending.size >= maxPending) throw new PublicError('Too many prepared messages waiting. Send or let them expire first.');
    const code = randomBytes(4).toString('hex');
    this.#pending.set(code, { action, request, preview, verify, expiresAt: now + codeTtl });
    return { action, ...preview, confirmationCode: code, expiresInMinutes: codeTtl / 60_000,
      note: 'Nothing has been sent. Show this to the parent, and call send_prepared with the code only after they approve it.' };
  }

  // Staff a parent can write to for this child, as the portal returns them (IsMine: the child's own teachers).
  async #staff(found) {
    const data = await this.#mobile.getJson(`/api/mychildsteachers?schoolId=${encodeURIComponent(found.schoolCode)}&childId=${encodeURIComponent(found.userName)}`);
    return (Array.isArray(data?.Users) ? data.Users : []).filter((user) => user && typeof user.Username === 'string' && user.Username);
  }

  async listRecipients({ child } = {}) {
    const found = await this.#portal.childFor(child);
    const users = await this.#staff(found);
    return { child: found.name, recipients: users.map((user) => ({
      username: clean(user.Username), name: clean(user.FullName),
      groups: (Array.isArray(user.Groups) ? user.Groups : []).map((group) => clean(group?.FullName)).filter(Boolean),
      childsTeacher: user.IsMine === true,
    })).sort((a, b) => Number(b.childsTeacher) - Number(a.childsTeacher) || a.name.localeCompare(b.name, 'nb')) };
  }

  async prepareReply({ message_id: id, text: body, thread_id: threadId, include_other_parents: others = false } = {}) {
    const reply = text(body, 'Text', maxText);
    if (threadId !== undefined && typeof threadId !== 'string') throw new PublicError('thread_id must be text.');
    if (typeof others !== 'boolean') throw new PublicError('include_other_parents must be true or false.');
    const message = await this.#message(messageId(id));
    if (message.IsReplyAllowed === false) throw new PublicError('The school has turned off replies to this message.');
    const threads = Array.isArray(message.Threads) ? message.Threads : [];
    let thread;
    if (threadId !== undefined) {
      thread = threads.find((t) => t.ThreadId === threadId);
      if (!thread) throw new PublicError('No thread with that ID on this message.');
    } else if (threads.length > 1) {
      throw new PublicError(`This message has several threads. Choose one with thread_id: ${threads.map((t) => `${t.ThreadId} (${clean(t.DisplayText)})`).join(', ')}.`);
    } else thread = threads[0];
    let recipientId = message.Author;
    if (thread) {
      const loaded = await this.#mobile.getJson(`/Api/Message/GetMessageWithId?messageId=${message.Id}&threadId=${encodeURIComponent(thread.ThreadId)}&onBehalfOf=${encodeURIComponent(message.OnBehalfOf || '')}&isPortal=true`);
      recipientId = (Array.isArray(loaded) ? loaded : []).find((t) => t.ThreadId === thread.ThreadId)?.RecipientId;
    }
    if (!recipientId) throw new PublicError('Could not find who to reply to. Reply in the Skolemelding app instead.');
    // As in the web portal: the other guardians can only be added when a reply starts a new thread.
    let copyTo = [];
    if (others) {
      if (thread) throw new PublicError('The other parents can only be added when the reply starts a new thread; this message already has one.');
      if (message.CanAddOtherParents !== true) throw new PublicError('The school does not allow adding the other parents to replies to this message.');
      copyTo = await this.#otherParents(message.OnBehalfOf);
      if (!copyTo.length) throw new PublicError('No other parent is registered for this child.');
    }
    const request = { MessageId: message.Id, MessageText: reply, OnBehalfOf: message.OnBehalfOf || '', RecipientId: recipientId,
      ThreadId: thread?.ThreadId || '', AddOtherParentInThread: others, AddOtherTeacherInThread: false, TeacherRecipients: [] };
    const to = thread ? clean(thread.DisplayText) : clean(message.From);
    return this.#prepare('reply', { path: '/api/ThreadMessage', body: request },
      { ...await this.#describe(message), to: [to], ...(others ? { copyTo } : {}), inThread: Boolean(thread), text: reply }, null);
  }

  async prepareAnswer({ message_id: id, answer } = {}) {
    const given = { ja: 'Ja', nei: 'Nei', yes: 'Ja', no: 'Nei' }[String(answer).trim().toLowerCase()];
    if (!given) throw new PublicError('Answer must be "ja" or "nei".');
    const message = await this.#message(messageId(id));
    if (!message.IsFeedBackQuestion) throw new PublicError('This message has no yes/no question.');
    if (message.FeedbackGiven) throw new PublicError(`The question is already answered (${clean(message.FeedbackGiven)}).`);
    const body = { FeedbackGiven: given, Id: message.Id, MessageConfirmed: true, OnBehalfOf: message.OnBehalfOf || '' };
    return this.#prepare('answer', { path: '/Api/message/ConfirmFeedbackWithPossibleQuestion', body },
      { ...await this.#describe(message), question: plainText(message.QuestionText), answer: given },
      (after) => after.FeedbackGiven === given);
  }

  async prepareReadConfirmation({ message_id: id } = {}) {
    const message = await this.#message(messageId(id));
    if (!message.IsFeedBackReadConfirmation) throw new PublicError('The school has not asked for a read confirmation on this message.');
    if (message.IsMessageConfirmed) throw new PublicError('This message is already confirmed as read.');
    const body = { FeedbackGiven: '', Id: message.Id, MessageConfirmed: true, OnBehalfOf: message.OnBehalfOf || '' };
    return this.#prepare('confirm_read', { path: '/Api/message/ConfirmFeedbackWithPossibleQuestion', body },
      await this.#describe(message), (after) => after.IsMessageConfirmed === true);
  }

  async prepareMessage({ child, recipients, subject, text: body, include_other_parents: others = false } = {}) {
    if (!Array.isArray(recipients) || recipients.length === 0 || !recipients.every((r) => typeof r === 'string' && r)) {
      throw new PublicError('Recipients must be a list of usernames from list_recipients.');
    }
    if (typeof others !== 'boolean') throw new PublicError('include_other_parents must be true or false.');
    const header = text(subject, 'Subject', maxSubject);
    const message = text(body, 'Text', maxText);
    const found = await this.#portal.childFor(child);
    const [staff, settings] = await Promise.all([this.#staff(found), this.#mobile.getJson('/Api/Settings')]);
    const max = Number(settings?.MaxRecipientsForParents) || 5;
    const unique = [...new Set(recipients)];
    if (unique.length > max) throw new PublicError(`Skolemelding allows at most ${max} recipients per message.`);
    const unknown = unique.filter((username) => !staff.some((user) => user.Username === username));
    if (unknown.length) throw new PublicError(`Not a recipient you can write to: ${unknown.join(', ')}. Use usernames from list_recipients.`);
    const users = unique.map((username) => staff.find((user) => user.Username === username));
    const request = { Attachments: [], Body: html(message), ExistingFileIds: [], GroupRecipients: [], Header: header, IsCreatedOnWeb: true,
      IsReplyAllowed: true, IsSmsMessage: false, Scheduling: null, SmsNotification: false, UserRecipients: users, OnBehalfOf: found.userName,
      FeedbackQuestionRequired: false, FeedbackRequired: false, FeedbackQuestion: '', IsOtherUserAdded: others, OnBehalfOfNameForTeacher: '',
      IsSpecialMessage: false, HideReceivers: false, HideAuthorName: false };
    const copyTo = others ? await this.#otherParents(found.userName) : [];
    return this.#prepare('message', { path: '/Api/message/', body: request }, {
      child: found.name, to: users.map((user) => clean(user.FullName)), ...(others ? { copyTo } : {}), subject: header, text: message,
    }, null);
  }

  async prepareAbsence({ child, include_other_parents: others = false, ...when } = {}) {
    if (typeof others !== 'boolean') throw new PublicError('include_other_parents must be true or false.');
    const period = absenceTime(when, this.#now());
    const found = await this.#portal.childFor(child);
    const copyTo = others ? await this.#otherParents(found.userName) : [];
    if (others && !copyTo.length) throw new PublicError('No other parent is registered for this child.');
    // Same text and fields as the portal's form; the school receives it as an absence report.
    const body = `Elev: ${found.name} \n Tidspunkt for fravær: ${period}`;
    const request = { Body: body, IsAbsenceReport: true, IsCreatedOnWeb: true, IsReplyAllowed: true, OnBehalfOf: found.userName,
      SchoolId: found.schoolCode, IsOtherUserAdded: others, IsSpecialMessage: false, HideReceivers: false };
    return this.#prepare('absence', { path: '/Api/message/', body: request },
      { child: found.name, absence: period, ...(others ? { copyTo } : {}), text: body }, null);
  }

  async sendPrepared({ confirmation_code: code } = {}) {
    const entry = typeof code === 'string' ? this.#pending.get(code) : undefined;
    if (!entry || entry.expiresAt <= this.#now()) {
      this.#pending.delete(code);
      throw new PublicError('Unknown or expired confirmation code. Prepare the message again.');
    }
    this.#pending.delete(code);  // single use, also when sending fails, so nothing is ever sent twice by a retry
    const response = await this.#mobile.postJson(entry.request.path, entry.request.body);
    if (response === false) throw new PublicError('Skolemelding did not accept it. Check in the Skolemelding app.');
    let verified = null;
    if (entry.verify) {
      const after = await this.#message(String(entry.request.body.Id)).catch(() => null);
      verified = Boolean(after && entry.verify(after));
    }
    const result = { sent: true, action: entry.action, ...entry.preview, ...(verified === null ? {} : { verified }) };
    await mkdir(dirname(this.#log), { recursive: true, mode: 0o700 });
    await appendFile(this.#log, JSON.stringify({ time: new Date(this.#now()).toISOString(), ...result }) + '\n', { mode: 0o600 });
    if (verified === false) {
      return { ...result, note: 'Skolemelding accepted the request, but the message does not show it yet. Check in the Skolemelding app.' };
    }
    return result;
  }
}
