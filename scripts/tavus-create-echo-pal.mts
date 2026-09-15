import { loadEnv } from "../tests/harness.mts";

/**
 * One-shot: create a single echo PAL on a stock face.
 *
 * Does not clone a face or a voice. Prints TAVUS_PAL_ID for .env.local.
 * Refuses to run without TAVUS_API_KEY. If TAVUS_PAL_ID is already set, it
 * only GETs that PAL so we do not mint a second one.
 *
 * 200 responses are the measurement this script exists to record. 401s from
 * a dummy key are not a substitute. A 200 PAL/conversation is still not a
 * media-flow proof — it is only auth + JSON shape.
 */

const API = "https://tavusapi.com/v2";
const STOCK_FACE_ID = "rc9cff32ceba";

function summarize(label: string, status: number, body: string): void {
  console.log(`${label}  ${status}`);
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    console.log(`keys: ${keys.join(", ")}`);
    for (const field of [
      "pal_id",
      "pal_name",
      "pipeline_mode",
      "default_face_id",
      "conversation_id",
      "status",
    ]) {
      if (typeof parsed[field] === "string") {
        console.log(`${field}: ${parsed[field]}`);
      }
    }
    if (typeof parsed.conversation_url === "string") {
      try {
        const url = new URL(parsed.conversation_url);
        console.log(`conversation_url host: ${url.host} path: ${url.pathname}`);
      } catch {
        console.log("conversation_url: unparseable");
      }
    }
  } catch {
    console.log(body.slice(0, 400));
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const key = env.TAVUS_API_KEY;
  if (!key) {
    throw new Error("TAVUS_API_KEY is not set in .env.local");
  }

  const headers = {
    "content-type": "application/json",
    "x-api-key": key,
  };

  if (env.TAVUS_PAL_ID) {
    const existing = await fetch(`${API}/pals/${env.TAVUS_PAL_ID}`, { headers });
    summarize(`GET /v2/pals/${env.TAVUS_PAL_ID}`, existing.status, await existing.text());
    return;
  }

  const faces = await fetch(`${API}/faces?face_type=system&limit=20`, {
    headers,
  });
  const facesBody = await faces.text();
  console.log(`GET /v2/faces?face_type=system  ${faces.status}`);
  let faceId = STOCK_FACE_ID;
  try {
    const parsed = JSON.parse(facesBody) as {
      data?: { face_id?: string }[];
    };
    const ids = (parsed.data ?? [])
      .map((row) => row.face_id)
      .filter((id): id is string => Boolean(id));
    console.log(`system faces on first page: ${ids.length}`);
    console.log(`stock face ${STOCK_FACE_ID} present: ${ids.includes(STOCK_FACE_ID)}`);
    if (!ids.includes(STOCK_FACE_ID) && ids[0]) {
      console.log(`stock face missing; using ${ids[0]}`);
      faceId = ids[0];
    }
  } catch {
    console.log(facesBody.slice(0, 400));
  }

  const created = await fetch(`${API}/pals`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      pal_name: "Maya echo prototype",
      pipeline_mode: "echo",
      default_face_id: faceId,
    }),
  });
  const createdBody = await created.text();
  summarize("POST /v2/pals", created.status, createdBody);

  if (!created.ok) {
    process.exit(1);
  }

  const pal = JSON.parse(createdBody) as { pal_id?: string };
  if (!pal.pal_id) {
    throw new Error("PAL create returned no pal_id");
  }

  const conversation = await fetch(`${API}/conversations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      pal_id: pal.pal_id,
      conversation_name: "echo-http-probe-end-immediately",
    }),
  });
  const conversationBody = await conversation.text();
  summarize("POST /v2/conversations", conversation.status, conversationBody);

  const conversationId = (() => {
    try {
      return (JSON.parse(conversationBody) as { conversation_id?: string })
        .conversation_id;
    } catch {
      return undefined;
    }
  })();

  if (conversationId) {
    const ended = await fetch(`${API}/conversations/${conversationId}/end`, {
      method: "POST",
      headers,
    });
    summarize(
      `POST /v2/conversations/${conversationId}/end`,
      ended.status,
      await ended.text()
    );
  }

  console.log(`\nAdd to .env.local:\nTAVUS_PAL_ID=${pal.pal_id}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
