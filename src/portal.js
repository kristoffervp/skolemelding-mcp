import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { convert } from 'html-to-text';
import { attachmentDirPath } from './browser.js';
import { writePrivateFile } from './files.js';
import { MobileClient } from './mobile-client.js';

const origin = 'https://portal.skoleplattform.no';
const pageSize = 15;
const maxPages = 100;
// Messages seen by a search are reused for this long, so read state can lag by up to five minutes.
const cacheTtl = 5 * 60_000;
const maxNameBytes = 200;
// A scan of the whole inbox normally takes well under a minute; stop runaway scans instead of waiting forever.
const scanDeadline = 90_000;
// Deeply nested HTML is slow to convert, so very long bodies are cut after removing embedded images.
const maxHtmlLength = 300_000;
// Files of other types are saved with ".download" appended, so they are not opened or run by mistake.
const safeExtensions = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.rtf', '.txt', '.csv', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff',
  '.mp3', '.m4a', '.wav', '.mp4', '.mov', '.m4v', '.zip']);

// Format and control characters (text-direction overrides, zero-width and Unicode tag characters) can hide
// or disguise text, so they are removed from everything returned to the client.
const invisibleCharacters = /(?![\n\t])[\p{Cf}\p{Cc}]/gu;

function clean(text) {
  return String(text ?? '').toWellFormed().replace(invisibleCharacters, '');
}

// Content the parent cannot see in the app must not reach the AI client as ordinary text.
const hiddenStyles = ['display:none', 'display: none', 'visibility:hidden', 'visibility: hidden',
  'font-size:0;', 'font-size: 0;', 'font-size:0px', 'font-size: 0px'];
const textOptions = {
  wordwrap: false,
  limits: { maxDepth: 100, maxInputLength: maxHtmlLength },
  selectors: [
    ...hiddenStyles.map((style) => ({ selector: `[style*="${style}"]`, format: 'skip' })),
    { selector: '[style$="font-size:0"]', format: 'skip' }, { selector: '[style$="font-size: 0"]', format: 'skip' },
    { selector: '[hidden]', format: 'skip' }, { selector: 'img', format: 'skip' },
  ],
};

function attachmentInfo(path, messageId, index) {
  if (typeof path !== 'string') return null;
  let url;
  try { url = new URL(path, origin); }
  catch { return null; }
  if (url.origin !== origin || !url.pathname.startsWith('/globalassets/attachments/')) return null;
  let name;
  try { name = decodeURIComponent(url.pathname.split('/').pop()); }
  catch { name = url.pathname.split('/').pop(); }
  return { id: `${messageId}:${index}`, name, url: url.href };
}

function truncateBytes(text, budget) {
  let result = '';
  let bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > budget) break;
    result += character;
  }
  return result;
}

function fileName(messageId, index, name) {
  const cleaned = clean(name).normalize('NFC').replace(/[\n\t<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '');
  let extension = extname(cleaned);
  if (Buffer.byteLength(extension) > 20) extension = '';
  const base = truncateBytes(cleaned.slice(0, cleaned.length - extension.length), maxNameBytes - Buffer.byteLength(extension));
  const suffix = safeExtensions.has(extension.toLowerCase()) ? '' : '.download';
  return `${messageId}-${index}-${base || 'attachment'}${extension}${suffix}`;
}

function plainText(html) {
  const source = String(html || '').replace(/data:[^"')\s]{100,}/g, 'data:').slice(0, maxHtmlLength);
  try {
    return clean(convert(source, textOptions)).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  } catch {
    return '[This text could not be read.]';
  }
}

// Message IDs are numbers; "007" and "7" are the same message.
function normalizeId(id) {
  return id.replace(/^0+(?=\d)/, '');
}

export class Portal {
  #mobile;
  #attachmentDir;
  #cache = new Map();
  #lookups = new Map();
  #missing = new Map();
  #scans = Promise.resolve();
  #children;

  constructor({ mobile = new MobileClient(), attachmentDir = attachmentDirPath } = {}) {
    this.#mobile = mobile;
    this.#attachmentDir = attachmentDir;
  }

  async close() {}

  #remember(messages) {
    const now = Date.now();
    for (const [id, entry] of this.#cache) if (now - entry.at >= cacheTtl) this.#cache.delete(id);
    for (const message of messages) this.#cache.set(String(message.Id), { message, at: now });
  }

  #cached(id) {
    const entry = this.#cache.get(id);
    return entry && Date.now() - entry.at < cacheTtl ? entry.message : undefined;
  }

  // Only one inbox scan runs at a time, so many lookups at once cannot multiply the traffic to Skolemelding.
  #search(options) {
    const scan = this.#scans.then(() => this.#scan(options));
    this.#scans = scan.catch(() => {});
    return scan;
  }

  async #scan({ id, limit = 30, matches = () => true, filters = {} } = {}) {
    if (id && this.#cached(id)) return [];
    const messages = [];
    const started = Date.now();
    for (let page = 1; page <= maxPages; page++) {
      if (Date.now() - started > scanDeadline) throw new Error('Searching the inbox took too long. Try again later.');
      const payload = await this.#mobile.searchPage(page, pageSize, filters);
      messages.push(...payload.Result);
      this.#remember(payload.Result);
      if (id && messages.some((message) => String(message.Id) === id)) break;
      if (!id && messages.filter(matches).length >= limit) break;
      if (messages.length >= Number(payload.TotalMatching) || payload.Result.length < pageSize) break;
    }
    return messages;
  }

  async #find(id) {
    const cached = this.#cached(id);
    if (cached) return cached;
    const missingAt = this.#missing.get(id);
    if (missingAt && Date.now() - missingAt < cacheTtl) throw new Error('Message not found in the inbox.');
    if (!this.#lookups.has(id)) {
      this.#lookups.set(id, this.#search({ id }).finally(() => this.#lookups.delete(id)));
    }
    await this.#lookups.get(id);
    const message = this.#cached(id);
    if (!message) {
      this.#missing.set(id, Date.now());
      throw new Error('Message not found in the inbox.');
    }
    return message;
  }

  async #childList() {
    if (this.#children && Date.now() - this.#children.at < cacheTtl) return this.#children.list;
    const list = (await this.#mobile.getChildren())
      .filter((child) => child && child.UserName)
      .map((child) => {
        const firstNames = String(child.FirstName || '').trim();
        const lastName = String(child.LastName || '').trim();
        const givenName = firstNames.split(/\s+/)[0];
        const name = [firstNames, lastName].filter(Boolean).join(' ');
        // FirstName can include middle names, so also accept the first given name with or without the last name.
        const aliases = [name, firstNames, givenName, [givenName, lastName].filter(Boolean).join(' ')]
          .filter(Boolean).map((alias) => alias.toLocaleLowerCase('nb'));
        return { userName: String(child.UserName), name: clean(name), school: clean(child.SchoolName), aliases };
      });
    this.#children = { list, at: Date.now() };
    return list;
  }

  // Message annotations should not fail just because the child list is unavailable.
  async #childListOrEmpty() {
    try { return await this.#childList(); }
    catch { return []; }
  }

  #childUserNames(message) {
    const names = [message.OnBehalfOf, ...(Array.isArray(message.OnBehalfOfList) ? message.OnBehalfOfList : [])];
    return [...new Set(names.filter((name) => typeof name === 'string' && name))];
  }

  #thread(thread, includeHtml) {
    const result = { id: clean(thread.ThreadId), date: clean(thread.TimeStamp), label: clean(thread.DisplayText),
      unread: thread.IsSeen === false, text: plainText(thread.ThreadText) };
    if (includeHtml) result.html = thread.ThreadText || '';
    return result;
  }

  #normalize(message, { full = false, includeHtml = false, children = [] } = {}) {
    const id = String(message.Id);
    const attachments = (Array.isArray(message.Attachments) ? message.Attachments : [])
      .map((path, index) => attachmentInfo(path, id, index)).filter(Boolean);
    const result = {
      id,
      subject: clean(message.Header),
      sender: clean(message.From),
      children: this.#childUserNames(message)
        .map((userName) => children.find((child) => child.userName === userName)?.name).filter(Boolean),
      date: clean(message.Timestamp),
      unread: message.IsMessageSeen === false,
      attachmentNames: attachments.map(({ name }) => clean(name)),
    };
    // The school asks parents to answer a yes/no question or to confirm that they have read the message.
    if (message.IsFeedBackQuestion) result.question = plainText(message.QuestionText);
    if (message.IsFeedBackReadConfirmation) result.readConfirmationRequested = true;
    if (full) {
      result.bodyText = plainText(message.Body);
      if (includeHtml) result.bodyHtml = message.Body || '';
      result.attachments = attachments.map(({ id: attachmentId, name }) => ({ id: attachmentId, name: clean(name) }));
      result.threads = (Array.isArray(message.Threads) ? message.Threads : []).map((thread) => this.#thread(thread, includeHtml));
    } else {
      result.preview = message.SearchText ? clean(message.SearchText) : plainText(message.Body).slice(0, 240);
    }
    return result;
  }

  async listChildren() {
    return (await this.#childList()).map(({ name, school }) => ({ name, school }));
  }

  async #findChild(query) {
    const children = await this.#childList();
    const wanted = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('nb');
    const found = children.filter((child) => child.aliases.includes(wanted));
    const known = children.map(({ name }) => name).join(', ') || 'none';
    if (found.length === 0) throw new Error(`No child named "${query}" on this account. Children: ${known}.`);
    if (found.length > 1) throw new Error(`"${query}" matches more than one child. Use the full name: ${known}.`);
    return { child: found[0], children };
  }

  async listMessages(limit = 30, { child, search, unreadOnly = false, questionsOnly = false, absenceOnly = false } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be an integer from 1 to 100.');
    if (child !== undefined && (typeof child !== 'string' || !child.trim())) throw new Error('Child must be a non-empty name.');
    if (search !== undefined && (typeof search !== 'string' || !search.trim() || search.length > 100)) {
      throw new Error('Search must be non-empty text of at most 100 characters.');
    }
    for (const flag of [unreadOnly, questionsOnly, absenceOnly]) {
      if (typeof flag !== 'boolean') throw new Error('Filters must be true or false.');
    }
    const filters = { search: search?.trim() ?? '', unread: unreadOnly, question: questionsOnly, absence: absenceOnly };
    let children;
    let matches = () => true;
    if (child === undefined) children = await this.#childListOrEmpty();
    else {
      const found = await this.#findChild(child);
      children = found.children;
      matches = (message) => this.#childUserNames(message).includes(found.child.userName);
    }
    const messages = (await this.#search({ limit, matches, filters })).filter(matches).slice(0, limit);
    return messages.map((message) => this.#normalize(message, { children }));
  }

  async getMessage(id, { includeHtml = false } = {}) {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error('Invalid message ID.');
    const [message, children] = await Promise.all([this.#find(normalizeId(id)), this.#childListOrEmpty()]);
    return this.#normalize(message, { full: true, includeHtml, children });
  }

  async getAttachment(attachmentId, { includeContent = false } = {}) {
    const match = typeof attachmentId === 'string' && attachmentId.match(/^(\d+):(\d+)$/);
    if (!match) throw new Error('Invalid attachment ID.');
    const messageId = normalizeId(match[1]);
    const index = Number(match[2]);
    const message = await this.#find(messageId);
    const path = Array.isArray(message.Attachments) ? message.Attachments[index] : undefined;
    const attachment = attachmentInfo(path, messageId, index);
    if (!attachment) throw new Error('Attachment not found.');
    const { bytes, mimeType } = await this.#mobile.getAttachment(attachment.url);
    await mkdir(this.#attachmentDir, { recursive: true, mode: 0o700 });
    const filePath = join(this.#attachmentDir, fileName(messageId, index, attachment.name));
    await writePrivateFile(filePath, bytes, { downloaded: true });
    const result = { id: `${messageId}:${index}`, name: clean(attachment.name), mimeType, size: bytes.length, path: filePath };
    return includeContent ? { ...result, bytes } : result;
  }
}
