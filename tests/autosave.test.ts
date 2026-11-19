import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoSave } from '../apps/web/autosave';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('debounces small batches and caps the age of continuously edited data', () => {
  const flush = vi.fn(),
    scheduler = new AutoSave(flush);
  const edit = () => {
    scheduler.recordEdit();
    scheduler.update(true, false);
  };
  edit();
  // Rechecking UI state alone never postpones the write.
  vi.advanceTimersByTime(9000);
  scheduler.update(true, false);
  vi.advanceTimersByTime(999);
  expect(flush).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(flush).toHaveBeenCalledTimes(1);
  scheduler.reset();
  flush.mockClear();
  edit();
  for (let i = 0; i < 11; i++) {
    vi.advanceTimersByTime(5000);
    edit();
  }
  vi.advanceTimersByTime(4999);
  expect(flush).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(flush).toHaveBeenCalledTimes(1);
});

it('shortens the idle delay at 20 changes, and cancels work on undo or switching books', () => {
  const flush = vi.fn(),
    scheduler = new AutoSave(flush);
  for (let i = 0; i < 19; i++) scheduler.recordEdit();
  scheduler.update(true, false);
  vi.advanceTimersByTime(1000);
  expect(flush).not.toHaveBeenCalled();
  scheduler.recordEdit();
  scheduler.update(true, false);
  vi.advanceTimersByTime(999);
  expect(flush).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(flush).toHaveBeenCalledTimes(1);
  scheduler.reset();
  flush.mockClear();
  scheduler.recordEdit();
  scheduler.update(true, false);
  scheduler.update(false, false);
  vi.advanceTimersByTime(60000);
  expect(flush).not.toHaveBeenCalled();
  scheduler.recordEdit();
  scheduler.update(true, false);
  scheduler.reset();
  vi.advanceTimersByTime(60000);
  expect(flush).not.toHaveBeenCalled();
});

it('pauses during input or conflict and delays retries after a failed write', () => {
  const flush = vi.fn(),
    scheduler = new AutoSave(flush);
  scheduler.recordEdit();
  scheduler.update(true, false);
  vi.advanceTimersByTime(2000);
  scheduler.update(true, true);
  vi.advanceTimersByTime(70000);
  expect(flush).not.toHaveBeenCalled();
  scheduler.update(true, false);
  vi.advanceTimersByTime(0);
  expect(flush).toHaveBeenCalledTimes(1);
  scheduler.reset();
  scheduler.retryLater();
  scheduler.update(true, false);
  vi.advanceTimersByTime(29999);
  expect(flush).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(flush).toHaveBeenCalledTimes(2);
});
