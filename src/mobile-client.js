import { PublicError } from './errors.js';
import { readLimited } from './files.js';
import { outdatedHint, portalOrigin as origin, readMobileAuth, refreshMobileAuth } from './mobile-auth.js';

const maxJsonBytes = 2_000_000;

// The parse error would quote the start of the response, so it is replaced.
async function readJson(response) {
  const text = (await readLimited(response, maxJsonBytes, 'Skolemelding sent a response that is too large.')).toString('utf8');
  try { return text ? JSON.parse(text) : null; }
  catch { throw new PublicError('Skolemelding sent an unexpected response.'); }
}

export class MobileClient {
  #auth;
  #refreshing;

  async open() {
    if (this.#auth) return;
    try { this.#auth = await readMobileAuth(); }
    catch (error) {
      if (error.code === 'ENOENT') throw new PublicError('Not signed in to Skolemelding. Run npm run login first.');
      throw error;
    }
  }

  async #refresh() {
    if (!this.#refreshing) {
      this.#refreshing = refreshMobileAuth(this.#auth).then((auth) => { this.#auth = auth; })
        .catch((error) => {
          if ([400, 401, 403].includes(error.httpStatus)) {
            throw new PublicError(`Skolemelding sign-in has expired or was rejected. Run npm run login again. ${outdatedHint}`);
          }
          throw error;
        })
        .finally(() => { this.#refreshing = undefined; });
    }
    await this.#refreshing;
  }

  async #request(path, options = {}) {
    await this.open();
    if (Date.now() >= this.#auth.expiresAt - 60_000) await this.#refresh();
    const send = async () => {
      try {
        return await fetch(new URL(path, origin), {
          ...options,
          headers: { ...options.headers, Authorization: `Bearer ${this.#auth.accessToken}` },
          redirect: 'manual', signal: AbortSignal.timeout(30_000),
        });
      } catch { throw new PublicError('Could not connect to Skolemelding. Check network access and retry.'); }
    };
    const sentWith = this.#auth.accessToken;
    let response = await send();
    if (response.status === 401) {
      // Another request may already have replaced the token; only refresh if this one used the current token.
      if (this.#auth.accessToken === sentWith) await this.#refresh();
      response = await send();
    }
    if (!response.ok) {
      const error = new PublicError(`Skolemelding request failed (HTTP ${response.status}).`);
      error.httpStatus = response.status;
      throw error;
    }
    return response;
  }

  async searchPage(page, pageSize, { search = '', unread = false, question = false, absence = false } = {}) {
    const response = await this.#request('/api/messagesearchmobile/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        Page: page, PageSize: pageSize, SearchTerm: search, SearchInbox: true,
        FilterSender: null, FilterUnreadMessages: unread, FilterFeedbackRequired: false,
        FilterFeedbackIsQuestion: question, FilterIsAbsentMessage: absence,
        OnBehalfOf: '', AuthorUserCategory: null, FilterFavouriteMessages: false,
        SendHiddenMessages: false,
      }),
    });
    const payload = await readJson(response);
    if (!Array.isArray(payload?.Result)) throw new PublicError('Unexpected mobile message response format.');
    return payload;
  }

  async getJson(path) {
    return readJson(await this.#request(path, { method: 'GET', headers: { Accept: 'application/json' } }));
  }

  // Used only by sending (src/sending.js). The response may be empty or plain JSON true/false.
  async postJson(path, body) {
    const response = await this.#request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    });
    const text = (await readLimited(response, maxJsonBytes, 'Skolemelding sent a response that is too large.')).toString('utf8');
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  }

  // The web portal's search: unlike the app search it includes Author, FeedbackGiven and IsMessageConfirmed,
  // which sending needs. sent: true searches the outbox.
  async webSearchPage(page, pageSize, { sent = false } = {}) {
    const payload = await this.postJson('/Api/MessageSearch', {
      AuthorUserCategroy: '', FilterSender: [], Page: page, PageSize: pageSize, SearchInbox: !sent, SearchOrder: '', SearchTerm: '',
      SearchSent: sent, FilterFavouriteMessages: false, FilterUnreadMessages: false, FilterFeedbackRequired: false,
      FilterFeedbackIsQuestion: false, FilterIsAbsentMessage: false, ShowAbsentMessages: false,
    });
    if (!Array.isArray(payload?.Result)) throw new PublicError('Unexpected web message response format.');
    return payload;
  }

  async getChildren() {
    const response = await this.#request('/api/MyProfile/GetChildInfo', { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await readJson(response);
    return Array.isArray(payload?.ParentChildOptions) ? payload.ParentChildOptions : [];
  }

  async getAttachment(url) {
    let response;
    try { response = await this.#request(url, { method: 'GET' }); }
    catch (error) {
      if ([403, 404, 410].includes(error.httpStatus)) {
        throw new PublicError(`Skolemelding refused this attachment (HTTP ${error.httpStatus}). It may have been removed.`);
      }
      throw error;
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    if (mimeType === 'text/html') throw new PublicError('Attachment request returned a sign-in page.');
    const bytes = await readLimited(response, 10_000_000, 'Attachment exceeds the 10 MB response limit.');
    return { bytes, mimeType };
  }
}
