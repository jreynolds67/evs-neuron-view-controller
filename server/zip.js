// server/zip.js
// Minimal ZIP writer (store method, no compression). Dependency-free — enough to bundle
// already-binary snapshot export files into a single .zip for selective re-import.
// Not a general-purpose zip; it writes local file headers + central directory for the
// STORE method with CRC-32, which is all we need.

import { crc32 } from 'node:zlib';

function dosDateTime(date) {
  const d = date;
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const day = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, day };
}

// entries: [{ name: string, data: Buffer }]
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data) >>> 0;
    const size = data.length;

    // Local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // signature
    lfh.writeUInt16LE(20, 4);           // version needed
    lfh.writeUInt16LE(0, 6);            // flags
    lfh.writeUInt16LE(0, 8);            // method 0 = store
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(day, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18);        // compressed size
    lfh.writeUInt32LE(size, 22);        // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);           // extra length

    chunks.push(lfh, nameBuf, data);
    const localHeaderOffset = offset;
    offset += lfh.length + nameBuf.length + data.length;

    // Central directory record
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);           // version made by
    cdh.writeUInt16LE(20, 6);           // version needed
    cdh.writeUInt16LE(0, 8);            // flags
    cdh.writeUInt16LE(0, 10);           // method
    cdh.writeUInt16LE(time, 12);
    cdh.writeUInt16LE(day, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(size, 20);
    cdh.writeUInt32LE(size, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);           // extra
    cdh.writeUInt16LE(0, 32);           // comment
    cdh.writeUInt16LE(0, 34);           // disk number
    cdh.writeUInt16LE(0, 36);           // internal attrs
    cdh.writeUInt32LE(0, 38);           // external attrs
    cdh.writeUInt32LE(localHeaderOffset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}
