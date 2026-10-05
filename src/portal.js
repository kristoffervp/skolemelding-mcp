import { convert } from 'html-to-text';
import { MobileClient } from './mobile-client.js';

const origin = 'https://portal.skoleplattform.no';

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

function plainText(html) {
  return convert(html || '', { wordwrap: false })
    .replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

export class Portal {
  #mobile = new MobileClient();

  async close() {}

  async #search({ id, limit = 30 } = {}) {
    const messages = [];
    for (let page = 1; page <= 100; page++) {
      const payload = await this.#mobile.searchPage(page);
      messages.push(...payload.Result);
      if (id && messages.some((message) => String(message.Id) === id)) break;
      if (!id && messages.length >= limit) break;
      if (messages.length >= Number(payload.TotalMatching) || payload.Result.length < 15) break;
    }
    return messages;
  }

  #normalize(message, { full = false } = {}) {
    const id = String(message.Id);
    const attachments = (Array.isArray(message.Attachments) ? message.Attachments : [])
      .map((path, index) => attachmentInfo(path, id, index)).filter(Boolean);
    const result = {
      id,
      subject: message.Header || '',
      sender: message.From || '',
      recipients: message.To || message.Receiver || '',
      date: message.Timestamp || '',
      unread: message.IsMessageSeen === false,
      attachmentNames: attachments.map(({ name }) => name),
    };
    if (full) {
      result.bodyText = plainText(message.Body);
      result.bodyHtml = message.Body || '';
      result.attachments = attachments.map(({ id: attachmentId, name }) => ({ id: attachmentId, name }));
      result.threads = message.Threads || [];
    } else {
      result.preview = message.SearchText || plainText(message.Body).slice(0, 240);
    }
    return result;
  }

  async listMessages(limit = 30) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be an integer from 1 to 100.');
    const messages = (await this.#search({ limit })).slice(0, limit);
    return messages.map((message) => this.#normalize(message));
  }

  async getMessage(id) {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error('Invalid message ID.');
    const message = (await this.#search({ id })).find((item) => String(item.Id) === id);
    if (!message) throw new Error('Message not found in the inbox.');
    return this.#normalize(message, { full: true });
  }

  async getAttachment(attachmentId) {
    const match = typeof attachmentId === 'string' && attachmentId.match(/^(\d+):(\d+)$/);
    if (!match) throw new Error('Invalid attachment ID.');
    const message = (await this.#search({ id: match[1] }))
      .find((item) => String(item.Id) === match[1]);
    if (!message) throw new Error('Message not found in the inbox.');
    const path = Array.isArray(message.Attachments) ? message.Attachments[Number(match[2])] : undefined;
    const attachment = attachmentInfo(path, match[1], Number(match[2]));
    if (!attachment) throw new Error('Attachment not found.');
    const { bytes, mimeType } = await this.#mobile.getAttachment(attachment.url);
    return { id: attachmentId, name: attachment.name, mimeType,
      size: bytes.length, base64: bytes.toString('base64') };
  }
}
