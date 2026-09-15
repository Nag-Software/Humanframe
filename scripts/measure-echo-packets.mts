import {
  DAILY_APP_MESSAGE_LIMIT_BYTES,
  echoAudioMessage,
  fitsDailyAppMessage,
  interruptMessage,
  pcm16BytesFor,
} from "../lib/call/echo-packet.ts";

const conversationId = "c" + "a".repeat(35);

for (const ms of [20, 40, 100] as const) {
  const packet = echoAudioMessage({
    conversationId,
    pcm: new Uint8Array(pcm16BytesFor(ms)),
    inferenceId: "inf",
    done: false,
  });
  console.log(
    `${ms} ms 16 kHz  ${packet.bytes} B  fit=${fitsDailyAppMessage(packet.bytes)}  cap=${DAILY_APP_MESSAGE_LIMIT_BYTES}`
  );
}

const over = echoAudioMessage({
  conversationId,
  pcm: new Uint8Array(pcm16BytesFor(200, 24_000)),
  sampleRate: 24_000,
  inferenceId: "inf",
  done: false,
});
console.log(
  `200 ms 24 kHz ${over.bytes} B  fit=${fitsDailyAppMessage(over.bytes)}`
);
console.log(`interrupt        ${interruptMessage(conversationId).bytes} B`);
console.log(`rate at 20 ms    ${1000 / 20} messages/s if the tap keeps up`);
