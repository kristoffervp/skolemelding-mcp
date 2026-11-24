# Changelog

[Norsk](CHANGELOG.no.md)

## 0.7.0 (2026-11-24)

- Sending, off unless `SKOLEMELDING_ALLOW_SEND=1`: reply in a thread, answer yes/no questions, confirm reading, write to staff, and report absence. Every send takes two steps: a `prepare_…` tool, then `send_prepared` with a one-time code. Sent items are logged in `.data/sent.jsonl`.
- Without the setting nothing changes, and the server only reads.

## 0.6.1 (2026-11-24)

- `npm run login:mobile` is removed. Use `npm run login`.
- The server reports its version from `package.json`. A test that sometimes failed when test files ran in parallel is fixed.

## 0.6.0 (2026-11-22)

- Every tool has an `outputSchema` and returns `structuredContent` as well as JSON text.
- `list_children` returns `{ "children": [...] }` and `list_messages` returns `{ "messages": [...] }`, not a bare list.

## 0.5.1 (2026-11-09)

- `npm run login` no longer keeps a browser profile, and `SKOLEMELDING_MOBILE_PROFILE` is removed. You can delete an old `.data/mobile-browser-profile/` folder.
- Invisible characters and hidden text are removed from messages.
- Unusual attachment types get `.download` added, and saved attachments are marked as downloaded on macOS and Windows.
- Messages no longer include `recipients`.
- One inbox scan at a time, stopped after 90 seconds. Errors no longer show local file paths.
- Sign-in requests don't follow redirects, one malformed message no longer breaks `list_messages` or `get_message`, and a refused attachment gives a clearer error ([#12](https://github.com/kristoffervp/skolemelding-mcp/issues/12)).
- `unread_only` no longer lists chats that Skolemelding marks as read.

## 0.5.0 (2026-11-09)

- `list_messages` takes `search`, `unread_only`, `questions_only` and `absence_only`.
- Messages show the school's yes/no question (`question`) and requests to confirm reading (`readConfirmationRequested`).

## 0.4.0 (2026-11-09)

- New tool `list_children`, and a `child` filter on `list_messages`. Each message shows which children it is about.

## 0.3.0 (2026-11-09)

- `get_attachment` saves the file and returns its path. The file itself comes only with `include_content: true`. Earlier versions always returned `base64`.
- `get_message` returns plain text. The HTML comes only with `include_html: true`.
- Several requests at once, and messages cached for five minutes.
- App version and client IDs can be set with environment variables. Tests run on GitHub for every change.

## 0.2.0 (2026-10-06)

- First public version: `list_messages`, `get_message` and `get_attachment`.
