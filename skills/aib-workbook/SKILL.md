---
name: aib-workbook
description: Read, edit, validate, or prepare reviewable changes to .aib JSON workbooks with the AIB CLI. Use for AIB workbook tasks or Excel/CSV conversion through AIB.
---

Use the installed `aib` command (on Windows the portable package includes `aib.cmd`). If the executable is outside PATH, invoke the copy bundled with the application.

For unfamiliar fields or operation shapes, run `aib context`. The distributed skill includes the same specification in `references/aib-context.json` for offline use. Its example is synthetic. Use `aib context "book.aib"` to include the target's sheet IDs, names, dimensions, date system and revision hash. Read the relevant cell range separately.

- For a focused read, use `aib read "book.aib" --sheet "Sales" --range A1:C10`. Add `--calculated` for formula results. Use `aib inspect "book.aib"` for the full workbook and hash when needed.
- For a proposed edit, generate a JSON operation array, then run `aib draft "book.aib" --ops ops.json`. Inspect `aib diff <id>` and `aib draft-validate <id>`. Apply with `aib apply <id>` when the requested workflow calls for it.
- For a requested direct edit, run `aib batch "book.aib" --ops ops.json --expected-hash <hash>`. On a conflict, read the latest revision and reassess the affected cells. Verify the result with `aib validate "book.aib"` and a focused read.
- For direct JSON editing and workbook creation without a CLI, or for offline XLS/XLSX/CSV conversion and standalone HTML export, see [English](references/en/aib-offline.md) or [中文](references/zh/aib-offline.md). Each Markdown file can also be given directly to another model. Use `aib --offline` for file operations without contacting the workbench.
