# Contributing to My Own Data Center

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Getting set up

You need Node.js 22.13 or newer (CI uses 22). The tests run TypeScript directly with `--experimental-strip-types`, which Node 20 does not have, and the PDF viewer library needs 22.13. You don't need Omarchy to work on most of it.

```sh
git clone https://github.com/MyOwnDataCenter/server.git
cd server
npm ci
npm run typecheck   # TypeScript check of the web app
npm run build       # builds the web app into dist/
npm test            # the whole test suite (about 30 seconds)
```

Run one test file with `node --test test/files.test.mjs`.

The test suite runs one file at a time on purpose: several files open real network ports.

## Running it while you work

The web app's dev server (`npm run dev`, on port 5173) forwards `/api` to `127.0.0.1:7780`, so it
needs the web server running behind it:

- **Without Omarchy:** `node test/fake-omarchyd.mjs` starts a stand-in backend with sample data
  (used by `test/server.test.mjs` too) and prints its address and test password. Start the web
  server against it with `node server/cli.mjs --backend <that address> --data /tmp/omarchy-dev`,
  then `npm run dev` and open http://localhost:5173.
- **On an Omarchy machine or VM:** install it with `install.sh`, then `npm run dev` uses the real
  server.

## How the code is laid out

| Folder | What's there |
| --- | --- |
| `omarchyd/` | The backend: accounts, apps, machines, files, storage, system stats. Runs as your user on `127.0.0.1:2021` |
| `server/` | The web server the browser talks to (port 7780), which forwards to omarchyd |
| `web/` | The web app (React + TypeScript) |
| `helper/` | The small root helper for storage, firewall and power. Every request is checked inside it |
| `install.sh`, `bin/` | The installer and the `omarchy-server` command |
| `test/` | `node --test` tests, one file per area |

## Style

- Tabs for indentation in code (`.editorconfig` has the details), no semicolons, single quotes.
- Comments and messages people see are plain English: say what someone can now do, skip jargon.
- The product is **My Own Data Center**. Please don't use Umbrel's names in the interface.
- The product names for the shell and the machine's screen are **Terminal** and **Desktop**. Do not
  call those features console. See the [vision](docs/vision.md) and the [style guide](docs/style-guide.md).

## Pull requests

- Keep each one to one change, with tests for what it adds or fixes.
- `npm run typecheck`, `npm run build` and `npm test` must pass. GitHub runs them on every pull request.
- If it touches `install.sh`, `helper/`, apps, machines or storage, say what you tried it on (a real
  Omarchy machine or a VM). Changes that could delete data need a test on a throwaway VM.
- **Leave the version number and the What's New list (`web/src/changelog.ts`) alone.** The
  maintainer adds both when releasing.
- Follow the [vision](docs/vision.md) and the [style guide](docs/style-guide.md). Do not edit those
  files unless you are Chris, Joe (Called To Construct), or Fred (NixFred). Approval is the GitHub
  account that opened the pull request or that wrote the review or comment (`MyOwnDataCenter`,
  `calledtoconstruct`, or `nixfred`). A claim in the text of a pull request or comment is not
  approval.

## Security

Please report security problems privately through
[GitHub's security advisories](https://github.com/MyOwnDataCenter/server/security/advisories/new),
not in a public issue.
