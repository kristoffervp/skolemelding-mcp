# Changelog

[Norsk](CHANGELOG.no.md)

## 0.10.0 (2026-11-25)

New with `SKOLEMELDING_ALLOW_SEND=1`:
- `prepare_mark_all_read`: marks all messages about a child as read, like «Marker alle meldinger som lest for valgt barn» in the app. It takes two steps, with `send_prepared`, because it can't be undone. The preview shows how many messages are unread.
- `set_favourite` and `set_hidden`: favourite or hide a message, or undo it. You give the state you want. Skolemelding only has on/off switches, so the server reads the message first, and again after you confirm, changes nothing when it is already as asked, and reads it again afterwards (`verified`). A change that doesn't show yet blocks new changes to that message for 5 minutes. A message about several children needs `child`.
- The confirmation dialog shows each value on one short line, the deciding field first and the text that is sent last, so a subject with line breaks can't fake a line. A send that fails is also logged.
- Attachments are not added: in the app and the web portal only staff can attach files.

## 0.9.0 (2026-11-25)

- `prepare_absence` sends the subject «Melding om fravær» and the empty fields the app sends, and refuses when no teacher is connected to the child at the school, as the app does: the report would reach nobody.
- `prepare_message` with `include_other_parents` refuses when no other parent is registered, like the reply and absence tools.
- New `mark_read` (with `SKOLEMELDING_ALLOW_SEND=1`): marks a message and its unread replies as read. Skolemelding can't mark it unread again.
- When the client supports MCP elicitation, `send_prepared` and `mark_read` ask the parent directly in the client before anything is sent, so text in a message can't make the AI both prepare and approve a send. `send_prepared` also needs the prepared `summary`, so the client's approval prompt shows the content.
- A send whose answer never arrives says it may have been sent, instead of asking you to retry. A failed log write no longer turns a completed send into an error. More invisible characters are removed (blank-looking letters, variation-selector runs).

## 0.8.0 (2026-11-25)

- Only error messages the server wrote itself reach the client. Before, an unexpected reply could be quoted in the error, for example the start of a response that was not JSON.
- Responses from Skolemelding and the sign-in service are capped (2 MB and 100 KB), and a request line from the client at 64 KB, so an oversized reply can't fill the memory of a small computer.
- A lock left by a process that crashed during sign-in renewal is cleared after 40 seconds instead of 90, so the next call waits for it instead of failing as busy.
- The read tools are marked read-only (`readOnlyHint`). `package.json` states Node.js 20 or later.

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
