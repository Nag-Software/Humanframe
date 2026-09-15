/**
 * Float32 (AudioWorklet) → PCM16LE at a target rate.
 *
 * The OpenAI WebRTC track is decoded by the browser, typically at 48 kHz.
 * Tavus audio echo wants 16 kHz PCM16. Linear interpolation is enough for a
 * prototype; a production resampler would be a different decision.
 */

export function resampleFloat32(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (input.length === 0 || fromRate === toRate) {
    return input;
  }

  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    output[i] = a + (b - a) * fraction;
  }

  return output;
}

export function floatToPcm16(input: Float32Array): Uint8Array {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < input.length; i += 1) {
    const clipped = Math.max(-1, Math.min(1, input[i] ?? 0));
    const sample = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
    view.setInt16(i * 2, sample, true);
  }
  return bytes;
}

/** RMS of a float buffer — used as a crude "is this track producing sound". */
export function rms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / input.length);
}
