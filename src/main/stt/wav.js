'use strict';

function pcm16ToWav(pcm, sampleRate = 16000) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function wavToPcm16(buf) {
  // Minimal reader for 16-bit PCM WAV (used by tests and the replay tool).
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && size >= 16 && off + 8 + 16 <= buf.length) {
      fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    }
    if (id === 'data') {
      const end = Math.min(buf.length, off + 8 + size);
      const bytes = buf.subarray(off + 8, end - ((end - off - 8) % 2));
      const pcm = new Int16Array(bytes.length / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
      return { pcm, ...(fmt || { channels: 1, sampleRate: 16000, bits: 16 }) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('not a PCM WAV file');
}

module.exports = { pcm16ToWav, wavToPcm16 };
