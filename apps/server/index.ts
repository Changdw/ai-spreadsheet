import { listenForBrowser } from './listen';
import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import lockfile from 'proper-lockfile';
import type { Server } from 'node:http';
import { home, atomicWrite, canonical, create, hash, load } from '../../packages/storage/index';
import { execute, errorResult, type Request } from '../../packages/service/index';
import { AibError, validate } from '../../packages/schema/index';
import { exportGuide } from '../resources';
import { openBrowser } from './browser';
import { chooseFile } from './file-dialog';
import { isLanguage } from '../language';

export interface ServerInfo {
  pid: number;
  port: number;
  token: string;
  version: 1;
}
const registry = () => path.join(home(), 'server.json');
export function webRoot() {
  return (
    process.env.AIB_WEB_DIR ||
    path.resolve(
      path.dirname(process.argv[1]),
      process.argv[1].endsWith('.ts') ? '../../dist/web' : 'web',
    )
  );
}
export async function discover(): Promise<ServerInfo | null> {
  try {
    const info = JSON.parse(await fs.readFile(registry(), 'utf8')) as ServerInfo;
    if (
      info.version !== 1 ||
      !Number.isInteger(info.port) ||
      info.port < 1 ||
      info.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(info.token)
    )
      return null;
    const r = await fetch(`http://127.0.0.1:${info.port}/api/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1000),
    });
    if (r.ok) return info;
  } catch {
    /* Missing or dead server: start a new instance on an OS-assigned port. */
  }
  return null;
}
export async function rpc(info: ServerInfo, request: Request) {
  const r = await fetch(`http://127.0.0.1:${info.port}/api/execute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(120000),
  });
  const payload = (await r.json()) as {
    ok: boolean;
    data: unknown;
    error: { code: string; message: string; details: unknown };
  };
  if (!payload.ok)
    throw new AibError(payload.error.code, payload.error.message, payload.error.details);
  return payload.data;
}
export async function startServer(
  port = 0,
  root = webRoot(),
): Promise<{ info: ServerInfo; server: Server; close: () => Promise<void> }> {
  await fs.access(path.join(root, 'index.html'));
  const app = express(),
    token = randomBytes(32).toString('hex'),
    files = new Map<string, string>();
  let actualPort = port;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
      res.status(403).json(errorResult(new AibError('FORBIDDEN', 'Invalid host')));
      return;
    }
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== `http://127.0.0.1:${actualPort}` &&
      origin !== `http://localhost:${actualPort}`
    ) {
      res.status(403).json(errorResult(new AibError('FORBIDDEN', 'Cross-origin request blocked')));
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.authorization !== `Bearer ${token}`) {
      res
        .status(401)
        .json(errorResult(new AibError('UNAUTHORIZED', 'Local session token required')));
      return;
    }
    next();
  });
  app.use(express.json({ limit: '100mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: 1 }));
  let picking = false;
  app.post('/api/file-dialog', async (req, res) => {
    if (picking) throw new AibError('DIALOG_OPEN', '系统文件窗口已经打开');
    picking = true;
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      const file = await chooseFile(req.body, controller.signal);
      res.json({ ok: true, data: file });
    } finally {
      picking = false;
    }
  });
  app.post('/api/save-copy', async (req, res) => {
    if (typeof req.body?.file !== 'string')
      throw new AibError('INVALID_ARGUMENT', '请选择保存位置');
    const copy = await create(req.body.file, validate(req.body.book));
    res.json({ ok: true, data: { file: copy.file } });
  });
  app.post('/api/export-guide', async (req, res) => {
    res.json({
      ok: true,
      data: await exportGuide(req.body?.target, path.dirname(root), req.body?.language),
    });
  });
  const themeFile = path.join(home(), 'theme.json');
  const languageFile = path.join(home(), 'language.json');
  app.get('/api/language', async (_req, res) => {
    const language = await fs.readFile(languageFile, 'utf8').then(JSON.parse, (error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    res.json({ ok: true, data: isLanguage(language) ? language : null });
  });
  app.post('/api/language', async (req, res) => {
    const language = req.body?.language;
    if (!isLanguage(language))
      throw new AibError('INVALID_ARGUMENT', 'Unsupported interface language');
    await atomicWrite(languageFile, JSON.stringify(language));
    res.json({ ok: true, data: language });
  });
  app.get('/api/theme', async (_req, res) => {
    const theme = await fs.readFile(themeFile, 'utf8').then(
      (text) => JSON.parse(text),
      (error) => {
        if (error.code === 'ENOENT') return 'system';
        throw error;
      },
    );
    res.json({ ok: true, data: theme });
  });
  app.post('/api/theme', async (req, res) => {
    const theme = req.body?.theme;
    if (!['system', 'light', 'dark'].includes(theme))
      throw new AibError('INVALID_ARGUMENT', '未知主题');
    await atomicWrite(themeFile, JSON.stringify(theme));
    res.json({ ok: true, data: theme });
  });
  app.post('/api/stop', (_req, res) => {
    res.json({ ok: true });
    setImmediate(() => {
      void close();
    });
  });
  app.post('/api/open', async (req, res) => {
    const file = await canonical(req.body.file);
    await load(file);
    const id = hash(process.platform === 'win32' ? file.toLowerCase() : file).slice(0, 32);
    files.set(id, file);
    res.json({ ok: true, data: { id, file } });
  });
  app.post('/api/execute', async (req, res) =>
    res.json({ ok: true, data: await execute(req.body) }),
  );
  app.get('/api/books/:id', async (req, res) => {
    const file = files.get(req.params.id);
    if (!file) throw new AibError('NOT_FOUND', 'Open this document using aib open');
    res.json({ ok: true, data: await execute({ command: 'snapshot', file }) });
  });
  app.get('/api/books/:id/revision', async (req, res) => {
    const file = files.get(req.params.id);
    if (!file) throw new AibError('NOT_FOUND', 'Document not open');
    res.json({ ok: true, data: { hash: hash(await fs.readFile(file)) } });
  });
  app.post('/api/books/:id', async (req, res) => {
    const file = files.get(req.params.id);
    if (!file) throw new AibError('NOT_FOUND', 'Document not open');
    res.json({ ok: true, data: await execute({ ...req.body, file }) });
  });
  app.use(express.static(root, { index: 'index.html', etag: true }));
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const result = errorResult(error);
      res.status(result.error.code === 'CONFLICT' ? 409 : 400).json(result);
    },
  );
  const server = await listenForBrowser(app, port);
  actualPort = (server.address() as { port: number }).port;
  const info: ServerInfo = { pid: process.pid, port: actualPort, token, version: 1 };
  await atomicWrite(registry(), JSON.stringify(info));
  const close = async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    try {
      const current = JSON.parse(await fs.readFile(registry(), 'utf8'));
      if (current.token === token) await fs.rm(registry());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  };
  return { info, server, close };
}
export async function ensureServer() {
  const ready = await discover();
  if (ready) return ready;
  const release = await startupLock();
  try {
    const existing = await discover();
    if (existing) return existing;
    const cli = path.resolve(process.argv[1]);
    const child = spawn(
      process.execPath,
      [...(cli.endsWith('.ts') ? ['--import', 'tsx'] : []), cli, 'serve', '--internal'],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: path.resolve(path.dirname(cli), cli.endsWith('.ts') ? '../..' : '.'),
        env: process.env,
      },
    );
    let failure: Error | undefined;
    child.on('error', (e) => {
      failure = e;
    });
    child.unref();
    for (let i = 0; i < 60; i++) {
      if (failure) throw failure;
      const info = await discover();
      if (info) return info;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new AibError(
      'SERVER_START_FAILED',
      'Server did not start. Run aib serve to inspect the error; build the Web app first.',
    );
  } finally {
    await release();
  }
}
export async function startupLock() {
  await fs.mkdir(home(), { recursive: true });
  return lockfile.lock(path.join(home(), 'startup'), {
    realpath: false,
    stale: 30000,
    retries: { retries: 40, minTimeout: 100, maxTimeout: 300 },
  });
}
export async function openFile(file?: string, browser = true) {
  const info = await ensureServer();
  let id = '';
  if (file) {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: path.resolve(file) }),
    });
    const result = (await response.json()) as {
      ok: boolean;
      data: { id: string };
      error: { code: string; message: string };
    };
    if (!result.ok) throw new AibError(result.error.code, result.error.message);
    id = result.data.id;
  }
  const url = `http://127.0.0.1:${info.port}/${id ? '?book=' + id : ''}#token=${info.token}`;
  if (browser && process.env.AIB_NO_BROWSER !== '1') {
    await openBrowser(url);
  }
  return { file: file ? path.resolve(file) : null, url };
}
