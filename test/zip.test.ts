import { describe, expect, test } from "bun:test";

import {
  createStoredZip,
  createStoredZipStream,
  MAX_STORED_ZIP_ENTRIES,
  type StoredZipEntry,
} from "../src/workbench/zip";

const decoder = new TextDecoder();

interface ParsedEntry {
  bytes: Uint8Array;
  centralCrc32: number;
  centralOffset: number;
  localCrc32: number;
  name: string;
}

function parseZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = bytes.length - 22;
  expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
  expect(view.getUint16(endOffset + 4, true)).toBe(0);
  expect(view.getUint16(endOffset + 6, true)).toBe(0);
  const entryCount = view.getUint16(endOffset + 8, true);
  expect(view.getUint16(endOffset + 10, true)).toBe(entryCount);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  expect(view.getUint16(endOffset + 20, true)).toBe(0);
  expect(centralOffset + centralSize).toBe(endOffset);

  const entries: ParsedEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    expect(view.getUint16(offset + 4, true)).toBe(0x0314);
    expect(view.getUint16(offset + 6, true)).toBe(20);
    expect(view.getUint16(offset + 8, true)).toBe(0x0800);
    expect(view.getUint16(offset + 10, true)).toBe(0);
    expect(view.getUint16(offset + 12, true)).toBe(0);
    expect(view.getUint16(offset + 14, true)).toBe(0x21);
    const centralCrc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    expect(view.getUint32(offset + 24, true)).toBe(compressedSize);
    const nameLength = view.getUint16(offset + 28, true);
    expect(view.getUint16(offset + 30, true)).toBe(0);
    expect(view.getUint16(offset + 32, true)).toBe(0);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    expect(view.getUint16(localOffset + 6, true)).toBe(0x0800);
    expect(view.getUint16(localOffset + 8, true)).toBe(0);
    expect(view.getUint16(localOffset + 10, true)).toBe(0);
    expect(view.getUint16(localOffset + 12, true)).toBe(0x21);
    const localCrc32 = view.getUint32(localOffset + 14, true);
    expect(view.getUint32(localOffset + 18, true)).toBe(compressedSize);
    expect(view.getUint32(localOffset + 22, true)).toBe(compressedSize);
    const localNameLength = view.getUint16(localOffset + 26, true);
    expect(view.getUint16(localOffset + 28, true)).toBe(0);
    expect(
      decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)),
    ).toBe(name);
    const dataOffset = localOffset + 30 + localNameLength;
    entries.push({
      bytes: bytes.slice(dataOffset, dataOffset + compressedSize),
      centralCrc32,
      centralOffset: offset,
      localCrc32,
      name,
    });
    offset += 46 + nameLength;
  }
  expect(offset).toBe(endOffset);
  return entries;
}

describe("deterministic stored ZIP", () => {
  test("preserves ordered UTF-8 names and bytes with fixed metadata and valid CRC-32", () => {
    const entries = [
      { name: "01-icon.png", bytes: new Uint8Array() },
      { name: "nested/02-éclair.webp", bytes: new TextEncoder().encode("123456789") },
    ];

    const first = createStoredZip(entries);
    const second = createStoredZip(entries);
    expect(first).toEqual(second);

    const parsed = parseZip(first);
    expect(parsed.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name));
    expect(parsed.map((entry) => entry.bytes)).toEqual(entries.map((entry) => entry.bytes));
    expect(parsed[0].centralOffset).toBeLessThan(parsed[1].centralOffset);
    for (const [index, entry] of parsed.entries()) {
      const expectedCrc32 = Bun.hash.crc32(entries[index].bytes);
      expect(entry.localCrc32).toBe(expectedCrc32);
      expect(entry.centralCrc32).toBe(expectedCrc32);
    }
    expect(parsed[1].centralCrc32).toBe(0xcbf43926);
  });

  test("streams byte-identical output in bounded chunks", async () => {
    const entries = [
      { name: "large.bin", bytes: new Uint8Array(150 * 1024).fill(7) },
      { name: "small.txt", bytes: new TextEncoder().encode("small") },
    ];
    const expected = createStoredZip(entries);
    const streamed = createStoredZipStream(entries);
    const reader = streamed.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }

    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(64 * 1024);
    expect(streamed.byteLength).toBe(expected.length);
    const actual = new Uint8Array(streamed.byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      actual.set(chunk, offset);
      offset += chunk.length;
    }
    expect(actual).toEqual(expected);
  });

  test("rejects empty archives, duplicate names, and invalid entry bytes", () => {
    expect(() => createStoredZip([])).toThrow("at least one entry");
    expect(() =>
      createStoredZip([
        { name: "same.png", bytes: new Uint8Array() },
        { name: "same.png", bytes: new Uint8Array([1]) },
      ]),
    ).toThrow("Duplicate ZIP entry name");
    expect(() =>
      createStoredZip([{ name: "invalid.png", bytes: null } as unknown as StoredZipEntry]),
    ).toThrow("Uint8Array");
  });

  test("rejects unsafe, malformed, and overlong names", () => {
    for (const name of [
      "",
      "/absolute.png",
      "C:/absolute.png",
      "C:drive-relative.png",
      "../escape.png",
      "nested/../escape.png",
      "nested/./file.png",
      "nested//file.png",
      "nested/",
      "back\\slash.png",
      "nul\0byte.png",
      "bad-\ud800.png",
    ]) {
      expect(() => createStoredZip([{ name, bytes: new Uint8Array() }])).toThrow(
        "safe relative UTF-8 path",
      );
    }
    expect(() => createStoredZip([{ name: "x".repeat(0x10000), bytes: new Uint8Array() }])).toThrow(
      "too long",
    );
  });

  test("rejects entry counts that require Zip64", () => {
    const entries = Array.from({ length: MAX_STORED_ZIP_ENTRIES + 1 }, (_, index) => ({
      name: `${index}.png`,
      bytes: new Uint8Array(),
    }));
    expect(() => createStoredZip(entries)).toThrow(`at most ${MAX_STORED_ZIP_ENTRIES}`);
  });
});
