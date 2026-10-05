import { readMobileAuth, refreshMobileAuth } from './mobile-auth.js';

const origin = 'https://portal.skoleplattform.no';

export class MobileClient {
  #auth;
  #refreshing;

  async open() {
    if (!this.#auth) this.#auth = await readMobileAuth();
  }

  async #refresh() {
    if (!this.#refreshing) {
      this.#refreshing = refreshMobileAuth(this.#auth).then((auth) => { this.#auth = auth; })
        .catch((error) => {
          if (error.httpStatus === 400 || error.httpStatus === 401) {
            throw new Error('Skolemelding mobile sign-in has expired. Run npm run login:mobile again.');
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
      } catch { throw new Error('Could not connect to Skolemelding. Check network access and retry.'); }
    };
    let response = await send();
    if (response.status === 401) {
      await this.#refresh();
      response = await send();
    }
    if (!response.ok) throw new Error(`Skolemelding request failed (HTTP ${response.status}).`);
    return response;
  }

  async searchPage(page, pageSize = 15) {
    const response = await this.#request('/api/messagesearchmobile/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        Page: page, PageSize: pageSize, SearchTerm: '', SearchInbox: true,
        FilterSender: null, FilterUnreadMessages: false, FilterFeedbackRequired: false,
        FilterFeedbackIsQuestion: false, FilterIsAbsentMessage: false,
        OnBehalfOf: '', AuthorUserCategory: null, FilterFavouriteMessages: false,
        SendHiddenMessages: false,
      }),
    });
    const payload = await response.json();
    if (!Array.isArray(payload.Result)) throw new Error('Unexpected mobile message response format.');
    return payload;
  }

  async getAttachment(url) {
    const response = await this.#request(url, { method: 'GET' });
    const mimeType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    if (mimeType === 'text/html') throw new Error('Attachment request returned a sign-in page.');
    const declaredSize = Number(response.headers.get('content-length'));
    if (declaredSize > 10_000_000) throw new Error('Attachment exceeds the 10 MB response limit.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.byteLength;
      if (size > 10_000_000) {
        await response.body.cancel().catch(() => {});
        throw new Error('Attachment exceeds the 10 MB response limit.');
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    return { bytes, mimeType };
  }
}
