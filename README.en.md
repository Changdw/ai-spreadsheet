# AIB · AI Spreadsheet Workbench

[中文](README.zh.md)

AIB stores an entire workbook as **one UTF-8 JSON file**. An agent can inspect a range, propose a small change, review its diff and verify a formula result. The local web editor and CLI use the same workbook format. Bring your own model.

| Task | Entry point |
| --- | --- |
| Open and edit a budget | [Quick start](docs/guide/en/aib-quickstart.html) |
| Use the workbench, CLI, npm tests and release scripts | [User guide](docs/guide/en/usage.html) |
| Install, build and troubleshoot | [Installation](docs/guide/en/installation.html) |
| Understand dependencies and file ownership | [Architecture](docs/guide/en/architecture.html) |
| Give an agent the format and conversion recipes | [Offline Markdown guide](skills/aib-workbook/references/en/aib-offline.md) |

Open the HTML documents locally after cloning.

## Run from source

Use Node.js 24.x with npm. Windows portable builds include the runtime.

```sh
npm ci
npm run build
npm run aib -- open examples/budget.aib
```

## Work with an agent

```sh
npm run --silent aib -- --offline context examples/budget.aib
npm run --silent aib -- --offline read examples/budget.aib --sheet "预算" --range D5 --calculated
npm run --silent aib -- --offline draft examples/budget.aib --ops examples/change-budget.json
```

The sample total is **14100**. A draft leaves the workbook available for review. Use its returned ID with `diff`, `draft-validate` and `apply`. Direct edits can supply `batch --expected-hash`. The schema preserves sheet IDs, formulas and typed literals, including leading-zero identifiers.

**Formats** · Import and export Microsoft Excel workbooks (.xlsx and .xls). Import CSV or export a single sheet as CSV. Export a workbook as offline HTML. Review the conversion-loss report before accepting changes.

**Development** · `npm run check` runs type, unit, documentation, build and browser checks. `npm run release:win` and `npm run release:mac` build local distribution archives on their respective platforms. Browser tests use Edge on Windows. Install Playwright Chromium on other platforms.

**Contributing** · Open an issue for a bug or a feature request. To contribute a change, create a branch from `main` in your fork and open a pull request against `main`. Include the behavior change and how you tested it. AIB CI tests and packages the app on Windows x64 and macOS arm64. Each successful platform job attaches its ZIP to the Actions run.

**License** · AIB’s own code uses the [MIT license](LICENSE). In the distribution archive, `dependencies.json` indexes the notices under `licenses/`. The Node.js notices are in `NODE-LICENSE.txt`. © 2026 AIB contributors.

AIB is an independent project. Microsoft and Excel are trademarks of the Microsoft group of companies.
