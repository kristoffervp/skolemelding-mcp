# Skolemelding MCP

English · [Norsk](README.no.md)

Read Skoleplattform Oslo messages and attachments through a local MCP server. Its three tools list messages, read a message, and download an attachment. They do not send replies or mark messages as read.

This is a simple local version that runs on your own computer. It lists up to 100 recent messages and does not yet offer keyword or date-range search.

At some Oslo schools, email notifications no longer include message contents or attachments. This MCP makes it easier to retrieve them from Skolemelding and use them in an agent workflow. You are responsible for deciding whether to share school information with ChatGPT or other cloud-based or commercial AI services.

**Tested only on macOS with Google Chrome. Other platforms and browsers have not been tested.**

## Install

Install Node.js 20 or later and Google Chrome. In Terminal, open this project folder and run:

```sh
npm install
npm run login
```

Complete the ID-porten sign-in in Chrome. Run `npm test` to check the server without using your account.

## Add to the ChatGPT desktop app

Open **Settings → MCP servers → Add server** and choose **STDIO**. Enter:

| Field | Value |
| --- | --- |
| Command to launch | Absolute path to Node.js; find it with `command -v node` |
| Arguments | One argument: absolute path to this project's `src/server.js` |
| Working directory | Absolute path to this project folder |
| Environment variables | Leave empty |

Save, restart ChatGPT, then type `/mcp` in a chat to check the connection. Replace the example paths in the screenshot with your own. The pictured `~/code` is only a placeholder for the working directory.

![ChatGPT desktop MCP server setup showing the command, argument, and working directory fields](docs/chatgpt-mcp-setup.png)

The [ChatGPT desktop app supports local MCP servers](https://learn.chatgpt.com/docs/extend/mcp). ChatGPT in a web browser does not use this local setup.

## Privacy and license

Your sign-in is stored in `.data/`. Keep it private. School messages sent to a cloud AI client may leave your computer. This integration uses undocumented Skolemelding endpoints that may change; if the session expires, run `npm run login` again.

The code and documentation use the [0BSD license](LICENSE): free for anyone to use, change, and share for any purpose, including commercial use, without attribution. The license does not cover the Skolemelding service or its data.

To publish, use Git and check `git status --short` before committing. `.gitignore` excludes local sign-ins, research files, installed packages, and ZIP archives. Do not upload the whole folder manually.
