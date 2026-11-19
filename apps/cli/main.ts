#!/usr/bin/env node
import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execute, errorResult, type Request } from '../../packages/service/index';
import { discover, rpc, startServer, openFile, startupLock } from '../server/index';
import { exportGuide } from '../resources';
import { AibError } from '../../packages/schema/index';

const program = new Command()
  .name('aib')
  .description('Local JSON workbook — CLI, AI drafts and browser editor')
  .version('0.1.0')
  .option('--json', 'Machine-readable output (always enabled)')
  .option('--offline', 'Execute file commands locally without contacting the AIB server');
program
  .command('find <file>')
  .requiredOption('--text <text>')
  .option('--sheet <sheet>')
  .action((file, o) => run({ command: 'find', file, args: o }));
program
  .command('stats <file>')
  .requiredOption('--sheet <sheet>')
  .requiredOption('--range <range>')
  .action((file, o) => run({ command: 'stats', file, args: o }));
program.configureOutput({ writeErr: () => {} });
const output = (data: unknown) => {
  process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
};
async function run(req: Request) {
  if (req.file) req.file = path.resolve(req.file);
  if (req.args)
    for (const key of ['source', 'target', 'other'])
      if (typeof req.args[key] === 'string') req.args[key] = path.resolve(req.args[key] as string);
  const server = program.opts().offline ? null : await discover();
  if (server) {
    try {
      return output(await rpc(server, req));
    } catch (error) {
      // An older running server can keep its open tabs while the upgraded CLI fills the file.
      if (
        req.command !== 'fill' ||
        !(error instanceof AibError) ||
        error.code !== 'UNKNOWN_COMMAND'
      )
        throw error;
    }
  }
  output(await execute(req));
}
async function jsonInput(file: string) {
  let text: string;
  if (file === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    text = Buffer.concat(chunks).toString('utf8');
  } else text = await fs.readFile(file, 'utf8');
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new AibError('INVALID_JSON', 'Invalid JSON input');
  }
}
program
  .command('new <file>')
  .option('--name <name>')
  .action((file, o) => run({ command: 'new', file, args: o }));
for (const command of ['inspect', 'validate', 'snapshot', 'recovery', 'revision'])
  program.command(`${command} <file>`).action((file) => run({ command, file }));
for (const command of ['capabilities', 'schema'])
  program.command(command).action(() => run({ command }));
program
  .command('context [file]')
  .description('Print the AIB specification and optional workbook metadata for AI tools')
  .action(async (file?: string) => output(await execute({ command: 'context', file })));
program
  .command('export-guide <target>')
  .description('Save the offline AIB guide as a Markdown file')
  .option('--lang <language>', 'Guide language (zh or en). Defaults to the system language.')
  .action(async (target: string, options: { lang?: string }) => {
    const entry = process.argv[1];
    const root = path.resolve(path.dirname(entry), entry.endsWith('.ts') ? '../..' : '.');
    output(await exportGuide(target, root, options.lang));
  });
program
  .command('read <file>')
  .requiredOption('--sheet <sheet>')
  .requiredOption('--range <range>')
  .option('--calculated', 'Return formula results')
  .action((file, o) => run({ command: 'read', file, args: o }));
program
  .command('fill <file>')
  .description('Extend a seed range in one direction using spreadsheet autofill')
  .requiredOption('--sheet <sheet>')
  .requiredOption('--range <range>', 'Seed cells, e.g. A1:A2')
  .requiredOption('--to <range>', 'Entire filled range including the seed, e.g. A1:A10')
  .option('--expected-hash <hash>')
  .action((file, o) => run({ command: 'fill', file, args: o }));
program
  .command('batch <file>')
  .requiredOption('--ops <json-file>', 'Operation array file; - for stdin')
  .option('--expected-hash <hash>')
  .action(async (file, o) =>
    run({
      command: 'batch',
      file,
      args: { operations: await jsonInput(o.ops), expectedHash: o.expectedHash },
    }),
  );
for (const command of ['undo', 'redo'])
  program
    .command(`${command} <file>`)
    .option('--expected-hash <hash>')
    .action((file, o) => run({ command, file, args: o }));
program
  .command('draft <file>')
  .requiredOption('--ops <json-file>')
  .action(async (file, o) =>
    run({ command: 'draft', file, args: { operations: await jsonInput(o.ops) } }),
  );
program.command('diff <id>').action((id) => run({ command: 'diff', args: { id } }));
program.command('apply <id>').action((id) => run({ command: 'apply', args: { id } }));
program
  .command('draft-edit <id>')
  .requiredOption('--ops <json-file>')
  .action(async (id, o) =>
    run({ command: 'draft-edit', args: { id, operations: await jsonInput(o.ops) } }),
  );
for (const command of ['draft-validate', 'draft-discard'])
  program.command(`${command} <id>`).action((id) => run({ command, args: { id } }));
program
  .command('save-as <file> <target>')
  .action((file, target) => run({ command: 'save-as', file, args: { target } }));
program
  .command('compare <file> <other>')
  .action((file, other) => run({ command: 'compare', file, args: { other } }));
program
  .command('recover <file> <id>')
  .requiredOption('--expected-hash <hash>')
  .action((file, id, o) =>
    run({ command: 'recover', file, args: { id, expectedHash: o.expectedHash } }),
  );
program
  .command('import <source> <file>')
  .option('--allow-lossy', 'Accept the reported unsupported features')
  .action((source, file, o) =>
    run({ command: 'import', file, args: { source, allowLossy: o.allowLossy } }),
  );
program
  .command('export <file> <target>')
  .description('Export to XLSX, XLS, CSV or a standalone read-only HTML file')
  .option('--sheet <sheet>', 'Required for CSV')
  .option('--formulas', 'CSV exports formulas instead of calculated values')
  .option('--allow-lossy')
  .action((file, target, o) => run({ command: 'export', file, args: { target, ...o } }));
program
  .command('open [file]')
  .option('--no-browser', 'Print local URL without opening browser')
  .action(async (file, o) => output(await openFile(file, o.browser)));
program.command('status').action(async () => {
  const info = await discover();
  output(info ? { running: true, pid: info.pid, port: info.port } : { running: false });
});
program.command('stop').action(async () => {
  const info = await discover();
  if (info) {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${info.token}` },
    });
    if (!r.ok) throw new AibError('STOP_FAILED', 'Server refused shutdown');
  }
  output({ stopped: true });
});
program
  .command('serve')
  .option('--port <port>', 'Local port, 0 chooses a free port', '0')
  .option('--internal')
  .action(async (o) => {
    const release = o.internal ? null : await startupLock();
    try {
      if (await discover())
        throw new AibError('SERVER_RUNNING', 'An AIB server is already running');
      const port = Number(o.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new AibError('INVALID_PORT', 'Port must be 0–65535');
      const s = await startServer(port);
      if (!o.internal) output({ port: s.info.port, pid: s.info.pid });
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.on(signal, () => {
          void s.close().then(() => process.exit(0));
        });
    } finally {
      await release?.();
    }
  });
program.exitOverride();
async function main() {
  try {
    await program.parseAsync();
  } catch (error) {
    const e = error as { code?: string };
    if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version')
      process.exitCode = 0;
    else {
      process.stderr.write(JSON.stringify(errorResult(error)) + '\n');
      process.exitCode = e.code === 'CONFLICT' ? 3 : 2;
    }
  }
}
void main();
