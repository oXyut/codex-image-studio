import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { Upload } from '../shared/types.js';
import { record } from '../shared/unknown.js';
import type { LineageStore } from './lineage-store.js';
import { AppError } from './validation.js';

type Dimensions = { width: number; height: number };
type PngHeader = Dimensions & { depth: number; color: number; interlace: number };
type JpegFrame = Dimensions & { components: number; ids: Set<number> };

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 16384;
const MAX_PIXELS = 40000000;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

function invalid(): never { throw new AppError('画像が壊れているか、対応していない形式です。PNG・JPEG・WebPの画像を選んでください。', 'INVALID_UPLOAD_IMAGE', 400); }
function dimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid();
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new AppError('画像が大きすぎます。各辺16,384px以内、4,000万画素以内の画像を選んでください。', 'UPLOAD_DIMENSIONS_TOO_LARGE', 400);
  return { width, height };
}
function crc32(buffer: Buffer) {
  let result = 0xffffffff;
  for (const value of buffer) result = crcTable[(result ^ value) & 255] ^ result >>> 8;
  return (result ^ 0xffffffff) >>> 0;
}

function inspectPng(buffer: Buffer) {
  let offset = 8, header: PngHeader | undefined, palette = false, imageStarted = false, imageEnded = false, ended = false;
  const compressed: Buffer[] = [];
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) invalid();
    const length = buffer.readUInt32BE(offset), end = offset + length + 12;
    if (end > buffer.length) invalid();
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) invalid();
    const chunk = buffer.subarray(offset + 8, end - 4);
    if (!header && type !== 'IHDR') invalid();
    if (imageStarted && type !== 'IDAT') imageEnded = true;
    if (type === 'IHDR') {
      if (header || length !== 13) invalid();
      const { width, height } = dimensions(chunk.readUInt32BE(0), chunk.readUInt32BE(4));
      const depth = chunk[8], color = chunk[9], interlace = chunk[12];
      const validDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!validDepths[color]?.includes(depth) || chunk[10] !== 0 || chunk[11] !== 0 || ![0, 1].includes(interlace)) invalid();
      header = { width, height, depth, color, interlace };
    } else if (type === 'PLTE') {
      if (palette || imageStarted || !length || length > 768 || length % 3 || [0, 4].includes(header!.color)) invalid();
      if (header!.color === 3 && length / 3 > 2 ** header!.depth) invalid();
      palette = true;
    } else if (type === 'IDAT') {
      if (imageEnded || (header!.color === 3 && !palette)) invalid();
      imageStarted = true; compressed.push(chunk);
    } else if (type === 'IEND') {
      if (length || !imageStarted || end !== buffer.length) invalid();
      ended = true; break;
    } else if (type === 'acTL') {
      throw new AppError('アニメーション画像は利用できません。静止画のPNG・JPEG・WebPを選んでください。', 'ANIMATED_UPLOAD_IMAGE', 400);
    } else if (type[0] === type[0].toUpperCase()) invalid();
    offset = end;
  }
  if (!header || !ended) invalid();
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[header!.color];
  const passes = header.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((header!.width - x) / dx)), height = Math.max(0, Math.ceil((header!.height - y) / dy));
    return width && height ? { height, length: Math.ceil(width * channels * header!.depth / 8) + 1 } : { height: 0, length: 0 };
  });
  const expectedLength = rows.reduce((sum, row) => sum + row.length * row.height, 0);
  // The expansion limit prevents a tiny compressed input from allocating more
  // memory than its declared image can use.
  let raw;
  try { raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedLength + 1 }); } catch { invalid(); }
  if (raw.length !== expectedLength) invalid();
  offset = 0;
  for (const row of rows) for (let y = 0; y < row.height; y++, offset += row.length) if (raw[offset] > 4) invalid();
  return { width: header!.width, height: header!.height };
}

function inspectJpeg(buffer: Buffer) {
  let offset = 2, frame: JpegFrame | undefined, scan = false, quantization = false, huffman = false, ended = false;
  while (offset < buffer.length) {
    if (buffer[offset++] !== 0xff) invalid();
    while (buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) invalid();
    const marker = buffer[offset++];
    if (marker === 0xd9) { ended = true; if (offset !== buffer.length) invalid(); break; }
    if (marker === 0xd8 || marker === 0x00 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) invalid();
    if (offset + 2 > buffer.length) invalid();
    const length = buffer.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > buffer.length) invalid();
    const chunk = buffer.subarray(offset + 2, end);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || chunk.length < 6 || chunk[0] !== 8) invalid();
      const { width, height } = dimensions(chunk.readUInt16BE(3), chunk.readUInt16BE(1));
      const components = chunk[5];
      if (![1, 3, 4].includes(components) || chunk.length !== 6 + 3 * components) invalid();
      const ids = new Set<number>();
      for (let index = 0; index < components; index++) {
        const at = 6 + index * 3, sampling = chunk[at + 1];
        if (ids.has(chunk[at]) || !(sampling >>> 4) || (sampling >>> 4) > 4 || !(sampling & 15) || (sampling & 15) > 4 || chunk[at + 2] > 3) invalid();
        ids.add(chunk[at]);
      }
      frame = { width, height, components, ids };
    } else if (marker === 0xdb) {
      let at = 0;
      while (at < chunk.length) {
        const info = chunk[at++], precision = info >>> 4;
        if (precision > 1 || (info & 15) > 3 || at + 64 * (precision + 1) > chunk.length) invalid();
        at += 64 * (precision + 1);
      }
      if (!at) invalid(); quantization = true;
    } else if (marker === 0xc4) {
      let at = 0;
      while (at < chunk.length) {
        if (at + 17 > chunk.length) invalid();
        const info = chunk[at++];
        if ((info >>> 4) > 1 || (info & 15) > 3) invalid();
        let count = 0, available = 1;
        for (let index = 0; index < 16; index++) { const entries = chunk[at++]; count += entries; available = available * 2 - entries; if (available < 0) invalid(); }
        if (!count || count > 256 || at + count > chunk.length) invalid();
        at += count;
      }
      if (!at) invalid(); huffman = true;
    } else if (marker === 0xda) {
      if (!frame || !quantization || !huffman || chunk.length < 4) invalid();
      const components = chunk[0];
      if (!components || components > frame.components || chunk.length !== 1 + 2 * components + 3) invalid();
      const ids = new Set<number>();
      for (let index = 0; index < components; index++) {
        const at = 1 + 2 * index;
        if (!frame.ids.has(chunk[at]) || ids.has(chunk[at]) || (chunk[at + 1] >>> 4) > 3 || (chunk[at + 1] & 15) > 3) invalid();
        ids.add(chunk[at]);
      }
      offset = end; let bytes = 0;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) { offset++; bytes++; continue; }
        const start = offset++;
        while (buffer[offset] === 0xff) offset++;
        if (offset >= buffer.length) invalid();
        if (buffer[offset] === 0 || buffer[offset] >= 0xd0 && buffer[offset] <= 0xd7) { offset++; bytes++; continue; }
        offset = start; break;
      }
      if (!bytes) invalid(); scan = true; continue;
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalid();
    offset = end;
  }
  if (!frame || !scan || !ended) invalid();
  return { width: frame.width, height: frame.height };
}

function inspectWebp(buffer: Buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(4) + 8 !== buffer.length) invalid();
  let offset = 12, frame: Dimensions | undefined, canvas: Dimensions | undefined, alpha = false;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) invalid();
    const type = buffer.toString('ascii', offset, offset + 4), length = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + length, paddedEnd = end + (length & 1);
    if (paddedEnd > buffer.length || length & 1 && buffer[end] !== 0) invalid();
    const chunk = buffer.subarray(offset + 8, end);
    if (type === 'VP8X') {
      if (offset !== 12 || canvas || length !== 10 || chunk[0] & 0xc1 || chunk.subarray(1, 4).some(value => value !== 0)) invalid();
      if (chunk[0] & 2) throw new AppError('アニメーション画像は利用できません。静止画のPNG・JPEG・WebPを選んでください。', 'ANIMATED_UPLOAD_IMAGE', 400);
      canvas = dimensions(chunk.readUIntLE(4, 3) + 1, chunk.readUIntLE(7, 3) + 1);
    } else if (type === 'VP8 ') {
      if (frame || length < 11 || chunk[0] & 1 || !chunk.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) invalid();
      const header = chunk.readUIntLE(0, 3), partitionLength = header >>> 5;
      if ((header >>> 1 & 7) > 3 || !(header & 16) || partitionLength < 1 || partitionLength + 10 >= length) invalid();
      frame = dimensions(chunk.readUInt16LE(6) & 0x3fff, chunk.readUInt16LE(8) & 0x3fff);
    } else if (type === 'VP8L') {
      if (frame || alpha || length < 6 || chunk[0] !== 0x2f) invalid();
      const bits = chunk.readUInt32LE(1);
      if (bits >>> 29) invalid();
      frame = dimensions((bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1);
    } else if (type === 'ALPH') {
      if (!canvas || frame || alpha || !length || (chunk[0] & 0xc3) > 1 || (chunk[0] >>> 4 & 3) > 1) invalid();
      alpha = true;
    } else if (type === 'ANIM' || type === 'ANMF') {
      throw new AppError('アニメーション画像は利用できません。静止画のPNG・JPEG・WebPを選んでください。', 'ANIMATED_UPLOAD_IMAGE', 400);
    } else if (!canvas || !['ICCP', 'EXIF', 'XMP '].includes(type)) invalid();
    offset = paddedEnd;
  }
  if (!frame || canvas && (canvas.width !== frame.width || canvas.height !== frame.height)) invalid();
  return frame;
}

export function inspectUpload(buffer: Buffer, mime: unknown) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) invalid();
  if (buffer.length > MAX_UPLOAD_BYTES) throw new AppError('アップロードできる画像は10MBまでです。', 'UPLOAD_TOO_LARGE', 413);
  if (typeof mime !== 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new AppError('PNG・JPEG・WebPの画像を選んでください。', 'UNSUPPORTED_UPLOAD_TYPE', 415);
  let type, result;
  try {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSignature)) { type = { mime: 'image/png', extension: 'png' }; result = inspectPng(buffer); }
    else if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) { type = { mime: 'image/jpeg', extension: 'jpg' }; result = inspectJpeg(buffer); }
    else if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') { type = { mime: 'image/webp', extension: 'webp' }; result = inspectWebp(buffer); }
    else invalid();
  } catch (error) { if (error instanceof AppError) throw error; invalid(); }
  if (type.mime !== mime) throw new AppError('画像の形式とContent-Typeが一致しません。', 'UPLOAD_TYPE_MISMATCH', 415);
  return { ...type, ...result, bytes: buffer.length };
}

function uploadName(value: unknown) {
  if (typeof value !== 'string' || value.length > 500) throw new AppError('ファイル名を確認してください。', 'INVALID_UPLOAD_NAME', 400);
  const name = value.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 160) || 'アップロード画像';
}

export class UploadStore {
  directory: string; uploads = new Map<string, Upload>(); lineage?: LineageStore;
  constructor(directory: string) { this.directory = directory;  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await lstat(this.directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new AppError('アップロード保存先を確認してください。', 'INVALID_UPLOAD_DIRECTORY');
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
      try {
        const directory = join(this.directory, entry.name), metadataPath = join(directory, 'upload.json');
        const metadataStat = await lstat(metadataPath);
        if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 64000) continue;
        const upload = JSON.parse(await readFile(metadataPath, 'utf8')) as Upload;
        if (upload.id !== entry.name || upload.kind !== 'upload' || upload.status !== 'uploaded' || typeof upload.createdAt !== 'string' || !Number.isFinite(Date.parse(upload.createdAt)) || uploadName(upload.name) !== upload.name || !/^image\.(png|jpg|webp)$/.test(upload.image?.fileName)) continue;
        const handle = await open(join(directory, upload.image.fileName), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_UPLOAD_BYTES) continue;
          const result = inspectUpload(await handle.readFile(), upload.image.mime);
          if (`image.${result.extension}` !== upload.image.fileName || result.bytes !== upload.image.bytes || result.width !== upload.image.width || result.height !== upload.image.height) continue;
        } finally { await handle.close(); }
        this.uploads.set(upload.id, structuredClone(upload));
      } catch (error) { if (record(error).code !== 'ENOENT') console.warn(`アップロード画像 ${entry.name} を読み込めませんでした。`); }
    }
  }
  list() { return [...this.uploads.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(value => structuredClone(value)); }
  get(id: string) {
    const upload = typeof id === 'string' && idPattern.test(id) ? this.uploads.get(id) : null;
    if (!upload) throw new AppError('アップロード画像が見つかりません。', 'UPLOAD_NOT_FOUND', 404);
    return structuredClone(upload);
  }
  async create(buffer: Buffer, { name = 'アップロード画像', mime }: { name?: string; mime?: string } = {}) {
    const image = inspectUpload(buffer, mime), id = randomUUID();
    const upload: Upload = { id, kind: 'upload', status: 'uploaded', name: uploadName(name), createdAt: new Date().toISOString(), image: { fileName: `image.${image.extension}`, mime: image.mime, bytes: image.bytes, width: image.width, height: image.height } };
    const root = await lstat(this.directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new AppError('アップロード保存先を確認してください。', 'INVALID_UPLOAD_DIRECTORY');
    const directory = join(this.directory, id);
    await mkdir(directory, { mode: 0o700 });
    try {
      await writeFile(join(directory, upload.image.fileName), buffer, { mode: 0o600, flag: 'wx' });
      await writeFile(join(directory, 'upload.json.tmp'), JSON.stringify(upload, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(join(directory, 'upload.json.tmp'), join(directory, 'upload.json'));
      this.uploads.set(id, upload); return structuredClone(upload);
    } catch (error) { await rm(directory, { recursive: true, force: true }).catch(() => {}); throw error; }
  }
  async imagePath(id: string) {
    this.lineage?.assertActive(id);
    const upload = this.get(id), directory = join(this.directory, id);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new AppError('参照画像のファイルを確認してください。', 'INVALID_REFERENCE_IMAGE', 400);
    const path = join(directory, upload.image.fileName);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new AppError('参照画像のファイルを確認してください。', 'INVALID_REFERENCE_IMAGE', 400); });
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== upload.image.bytes || stat.size > MAX_UPLOAD_BYTES) throw new AppError('参照画像のファイルを確認してください。', 'INVALID_REFERENCE_IMAGE', 400);
    } finally { await handle.close(); }
    return path;
  }
  async readImage(id: string) {
    const path = await this.imagePath(id);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new AppError('参照画像のファイルを確認してください。', 'INVALID_REFERENCE_IMAGE', 400); });
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_UPLOAD_BYTES) throw new AppError('参照画像のファイルを確認してください。', 'INVALID_REFERENCE_IMAGE', 400);
      return await handle.readFile();
    } finally { await handle.close(); }
  }
}
