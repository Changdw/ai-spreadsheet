import { InterfaceError } from './diagnostics';
export const token =
  new URLSearchParams(location.hash.slice(1)).get('token') ||
  sessionStorage.getItem('aib-token') ||
  '';
sessionStorage.setItem('aib-token', token);
history.replaceState(null, '', location.pathname + location.search);

export async function api(url: string, body?: unknown) {
  const r = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (
    r.status === 404 &&
    [
      '/api/file-dialog',
      '/api/theme',
      '/api/language',
      '/api/save-copy',
      '/api/export-guide',
    ].includes(url)
  )
    throw new InterfaceError('needUpdate');
  const p = await r.json();
  if (!p.ok) {
    const e = new Error(p.error.message) as Error & { code: string; details: unknown };
    e.code = p.error.code;
    e.details = p.error.details;
    throw e;
  }
  return p.data;
}
