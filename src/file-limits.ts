import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { eraSourceSizeLimit } from './era';

/**
 * Default source size limit. Generated bundles and dependency archives above
 * this limit provide no useful symbols; sourceSizeLimit applies the Era
 * module's larger script limit only to project-relative ERB paths.
 */
export const MAX_SOURCE_FILE_SIZE_BYTES = 1024 * 1024;

export function sourceSizeLimit(filePath: string): number {
  return eraSourceSizeLimit(filePath) ?? MAX_SOURCE_FILE_SIZE_BYTES;
}

/**
 * What stands in for content over sourceSizeLimit(filePath). Such a file is
 * never parsed, so its bytes are never needed — reading them only to hash and
 * discard cost multi-GB RSS spikes on committed video/blob fixtures and could
 * fail outright with `Invalid string length` (#1910). The stamp is a function
 * of size alone: change detection compares it to the stored hash, so a
 * same-size rewrite of an oversize file is not a change (nothing about it is
 * indexed), while crossing the limit in either direction is.
 */
export function oversizeStamp(size: number): string {
  return `codegraph:oversize:${size}`;
}

/**
 * The text whose hash the index stores for a file of `size` bytes: its content
 * within the limit, the size stamp over it. Anything that checks a file on disk
 * against its stored `contentHash` has to hash this, or every unchanged file
 * over the limit reads as drifted. `content` is only read within the limit.
 */
export function indexedHashInput(size: number, content: () => string, filePath = ''): string {
  return size > sourceSizeLimit(filePath) ? oversizeStamp(size) : content();
}

/** A source file's stats, and its bytes when they are within the limit (null = oversize). */
export interface BoundedSource {
  stats: fs.Stats;
  bytes: Buffer | null;
}

const READ_CHUNK_BYTES = 64 * 1024;

function assertRegularFile(stats: fs.Stats): void {
  if (!stats.isFile()) throw new Error('Source path is not a regular file');
}

/**
 * Read a source file without ever holding more than the limit plus one byte.
 * A stat before the read is not enough: the file can grow between the stat
 * and the read (a log, a download, a build output being written), so the
 * descriptor is re-checked after opening and the read itself stops one byte
 * past the limit. Returns `bytes: null` for an oversize file.
 */
export async function readBoundedSource(file: string, filePath = file): Promise<BoundedSource> {
  const limit = sourceSizeLimit(filePath);
  const initial = await fsp.stat(file);
  assertRegularFile(initial);
  if (initial.size > limit) return { stats: initial, bytes: null };
  const handle = await fsp.open(file, 'r');
  try {
    let stats = await handle.stat();
    assertRegularFile(stats);
    if (stats.size > limit) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = await handle.stat();
    if (size > limit || stats.size > limit) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    await handle.close();
  }
}

/** Synchronous {@link readBoundedSource}. */
export function readBoundedSourceSync(file: string, filePath = file): BoundedSource {
  const limit = sourceSizeLimit(filePath);
  const initial = fs.statSync(file);
  assertRegularFile(initial);
  if (initial.size > limit) return { stats: initial, bytes: null };
  const fd = fs.openSync(file, 'r');
  try {
    let stats = fs.fstatSync(fd);
    assertRegularFile(stats);
    if (stats.size > limit) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit + 1 - size));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = fs.fstatSync(fd);
    if (size > limit || stats.size > limit) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    fs.closeSync(fd);
  }
}
