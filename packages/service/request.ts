import { AibError } from '../schema/index';
export interface Request {
  command: string;
  file?: string;
  args?: Record<string, unknown>;
}
export const requiredString = (args: Record<string, unknown>, key: string) => {
  if (typeof args[key] !== 'string' || !args[key])
    throw new AibError('INVALID_ARGUMENT', `${key} is required`);
  return args[key] as string;
};
export function errorResult(error: unknown) {
  const e = error as Error & { code?: string; details?: unknown };
  return {
    ok: false,
    error: {
      code: e.code ?? 'INTERNAL_ERROR',
      message: e.message ?? String(error),
      ...(e.details ? { details: e.details } : {}),
    },
  };
}
