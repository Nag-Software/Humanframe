/**
 * Just enough WAV to split a two-channel call recording into one file per
 * speaker. Twilio records the caller and the AI on separate channels; keeping
 * them apart is what turns a transcript into a dialogue without a diarisation
 * model guessing who said what.
 */

export type WavInfo = {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Buffer;
};

const PCM = 1;
const MULAW = 7;

export function parseWav(buffer: Buffer): WavInfo {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }

  let offset = 12;
  let fmt: Omit<WavInfo, "data"> | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buffer.length);

    if (id === "fmt ") {
      fmt = {
        format: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(start, end);
    }
    offset = start + size + (size % 2);
  }

  if (!fmt || !data) throw new Error("WAV without fmt or data chunk");
  if (fmt.format !== PCM && fmt.format !== MULAW) {
    throw new Error(`Unsupported WAV format ${fmt.format}`);
  }
  return { ...fmt, data };
}

function mulawToLinear(value: number): number {
  const u = ~value & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign ? -sample : sample;
}

/** 16-bit PCM mono WAV for each channel. */
export function splitChannels(info: WavInfo): Buffer[] {
  const bytesPerSample = info.format === MULAW ? 1 : info.bitsPerSample / 8;
  if (info.format === PCM && info.bitsPerSample !== 16) {
    throw new Error(`Unsupported PCM depth ${info.bitsPerSample}`);
  }
  const frame = bytesPerSample * info.channels;
  const frames = Math.floor(info.data.length / frame);

  return Array.from({ length: info.channels }, (_, channel) => {
    const pcm = Buffer.alloc(frames * 2);
    for (let index = 0; index < frames; index += 1) {
      const at = index * frame + channel * bytesPerSample;
      const sample =
        info.format === MULAW ? mulawToLinear(info.data[at]) : info.data.readInt16LE(at);
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
    }
    return encodeWav(pcm, info.sampleRate);
  });
}

export function encodeWav(pcm16: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(PCM, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([header, pcm16]);
}

/** Root-mean-square level of a 16-bit mono WAV, 0..1. Silence is ~0. */
export function rmsLevel(wav: Buffer): number {
  const info = parseWav(wav);
  if (info.format !== PCM || info.bitsPerSample !== 16 || info.channels !== 1) return 1;
  const samples = Math.floor(info.data.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = info.data.readInt16LE(index * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

export function durationSeconds(info: WavInfo): number {
  const bytesPerSample = info.format === MULAW ? 1 : info.bitsPerSample / 8;
  return info.data.length / (bytesPerSample * info.channels * info.sampleRate);
}
