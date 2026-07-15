const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const ZIP_VERSION_MADE_BY = 0x0314; // Unix, ZIP 2.0
const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01

export const MAX_STORED_ZIP_ENTRIES = MAX_UINT16 - 1;

export interface StoredZipEntry {
  name: string;
  bytes: Uint8Array;
}

interface PreparedEntry extends StoredZipEntry {
  crc32: number;
  localOffset: number;
  nameBytes: Uint8Array;
}

const crc32Table = new Uint32Array(256);
for (let index = 0; index < crc32Table.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crc32Table[index] = value >>> 0;
}

function crc32(bytes: Uint8Array) {
  let value = MAX_UINT32;
  for (const byte of bytes) {
    value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ MAX_UINT32) >>> 0;
}

function invalidName(name: string) {
  if (name.length === 0 || !name.isWellFormed() || name.includes("\0") || name.includes("\\")) {
    return true;
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  return name.split("/").some((part) => !part || part === "." || part === "..");
}

function addSize(total: number, amount: number) {
  const result = total + amount;
  if (!Number.isSafeInteger(result) || result >= MAX_UINT32) {
    throw new Error("ZIP archive exceeds the classic ZIP size limit.");
  }
  return result;
}

export function createStoredZip(entries: readonly StoredZipEntry[]) {
  if (!entries.length) throw new Error("ZIP archive requires at least one entry.");
  if (entries.length > MAX_STORED_ZIP_ENTRIES) {
    throw new Error(`ZIP archive supports at most ${MAX_STORED_ZIP_ENTRIES} entries.`);
  }

  const encoder = new TextEncoder();
  const names = new Set<string>();
  const prepared: PreparedEntry[] = [];
  let localSize = 0;
  let centralSize = 0;

  for (const entry of entries) {
    if (typeof entry?.name !== "string" || invalidName(entry.name)) {
      throw new Error("ZIP entry name must be a safe relative UTF-8 path.");
    }
    if (names.has(entry.name)) throw new Error(`Duplicate ZIP entry name: ${entry.name}`);
    if (!(entry.bytes instanceof Uint8Array)) {
      throw new Error(`ZIP entry bytes must be a Uint8Array: ${entry.name}`);
    }

    const nameBytes = encoder.encode(entry.name);
    if (nameBytes.length > MAX_UINT16) {
      throw new Error(`ZIP entry name is too long: ${entry.name.slice(0, 80)}`);
    }
    if (entry.bytes.byteLength >= MAX_UINT32) {
      throw new Error(`ZIP entry exceeds the classic ZIP size limit: ${entry.name}`);
    }

    names.add(entry.name);
    prepared.push({
      ...entry,
      crc32: crc32(entry.bytes),
      localOffset: localSize,
      nameBytes,
    });
    localSize = addSize(localSize, LOCAL_FILE_HEADER_SIZE + nameBytes.length);
    localSize = addSize(localSize, entry.bytes.byteLength);
    centralSize = addSize(centralSize, CENTRAL_DIRECTORY_HEADER_SIZE + nameBytes.length);
  }

  let archiveSize = addSize(localSize, centralSize);
  archiveSize = addSize(archiveSize, END_OF_CENTRAL_DIRECTORY_SIZE);
  const output = new Uint8Array(archiveSize);
  const view = new DataView(output.buffer);
  let offset = 0;

  for (const entry of prepared) {
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, ZIP_VERSION, true);
    view.setUint16(offset + 6, UTF8_FLAG, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, DOS_TIME, true);
    view.setUint16(offset + 12, DOS_DATE, true);
    view.setUint32(offset + 14, entry.crc32, true);
    view.setUint32(offset + 18, entry.bytes.byteLength, true);
    view.setUint32(offset + 22, entry.bytes.byteLength, true);
    view.setUint16(offset + 26, entry.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    offset += LOCAL_FILE_HEADER_SIZE;
    output.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
    output.set(entry.bytes, offset);
    offset += entry.bytes.byteLength;
  }

  const centralOffset = offset;
  for (const entry of prepared) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, ZIP_VERSION_MADE_BY, true);
    view.setUint16(offset + 6, ZIP_VERSION, true);
    view.setUint16(offset + 8, UTF8_FLAG, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, DOS_TIME, true);
    view.setUint16(offset + 14, DOS_DATE, true);
    view.setUint32(offset + 16, entry.crc32, true);
    view.setUint32(offset + 20, entry.bytes.byteLength, true);
    view.setUint32(offset + 24, entry.bytes.byteLength, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, entry.localOffset, true);
    offset += CENTRAL_DIRECTORY_HEADER_SIZE;
    output.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
  }

  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralOffset, true);
  view.setUint16(offset + 20, 0, true);

  return output;
}
