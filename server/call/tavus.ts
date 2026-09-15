import { logger } from "@/lib/logger";
import { serverEnv } from "@/lib/env";

/**
 * The Tavus adapter for the FaceTime prototype.
 *
 * This is the only file that talks to tavusapi.com. It has no database handle,
 * no workspace id, and nothing that can reach the browser. The key stays on
 * the server. The browser receives a Daily conversation URL, which authorises
 * joining one already-created echo room and nothing else.
 *
 * Maya's voice is not configured here. An echo PAL has no TTS and no LLM;
 * we send OpenAI Live PCM in and Tavus returns a lip-synced face. Text echo
 * and `conversation.respond` are deliberately absent from this module.
 *
 * Measured against https://tavusapi.com on 2026-09-15. Auth header is
 * `x-api-key`. 400/401 probes are not a media-flow proof — they only pin
 * the error envelope and the field-validation order:
 *
 *   GET  /v2/pals                         no key     401
 *        {"message":"Invalid access token"}
 *   POST /v2/pals                         echo body, no default_face_id
 *        400 {"error":"Bad Request. {'default_face_id':
 *        ['default_face_id is required when creating a pal.']}"}
 *        Schema runs before auth. The echo quickstart omits the field.
 *   POST /v2/pals                         default_replica_id alias
 *        400 same default_face_id error — the legacy alias does not satisfy
 *        POST /v2/pals.
 *   POST /v2/pals                         default_face_id + echo + dummy key
 *        401 {"message":"Invalid access token"}
 *   POST /v2/conversations                dummy key
 *        401 {"message":"Invalid access token"}
 *
 * Live 200s with a real key, 2026-09-15. These prove auth and JSON shape,
 * not that Daily consumed echo audio or that a face appeared:
 *
 *   GET  /v2/faces?face_type=system       200, 20 system faces on page 1.
 *        Documented example rc9cff32ceba (Anna Casual) was not on that
 *        page. First listed stock face r9d30b0e55ac was used instead.
 *        No clone. pipeline_mode echo. No voice id.
 *   POST /v2/pals                         200
 *        keys: pal_id, pal_name, pal_description, created_at, tool_ids
 *        pal_name "Maya echo prototype". pal_id written to TAVUS_PAL_ID.
 *        pipeline_mode is accepted on create; it is not echoed in this body.
 *   POST /v2/conversations                200
 *        keys: conversation_id, conversation_name, conversation_url,
 *        status, callback_url, created_at, policy
 *        status "active". conversation_url host tavus.daily.co.
 *   POST /v2/conversations/{id}/end       200 (empty body)
 *
 * `conversation.realtime_api` is documented as no longer supported. Do not
 * send OpenAI Live events through Tavus.
 */

const API = "https://tavusapi.com/v2";
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Documented example face (Anna Casual). The live system-face list on
 * 2026-09-15 did not include it; the setup script fell back to the first
 * listed system face rather than cloning.
 */
export const STOCK_FACE_ID = "rc9cff32ceba";

export type TavusConversation = {
  conversationId: string;
  conversationUrl: string;
};

export type TavusPal = {
  palId: string;
  palName: string;
};

function apiKey(): string {
  const key = serverEnv().TAVUS_API_KEY;
  if (!key) {
    throw new Error("TAVUS_API_KEY is required for the FaceTime prototype");
  }
  return key;
}

function headers(): HeadersInit {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey(),
  };
}

export async function createEchoPal(input: {
  palName: string;
  faceId: string;
}): Promise<TavusPal> {
  const response = await fetch(`${API}/pals`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      pal_name: input.palName,
      pipeline_mode: "echo",
      default_face_id: input.faceId,
    }),
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    logger.error("facetime.pal_rejected", {
      status: response.status,
      code: safeError(detail),
    });
    throw new Error(`Tavus PAL rejected: ${response.status}`);
  }

  const body = (await response.json().catch(() => null)) as {
    pal_id?: string;
    pal_name?: string;
  } | null;

  if (!body?.pal_id) {
    throw new Error("Tavus PAL returned no id");
  }

  return { palId: body.pal_id, palName: body.pal_name ?? input.palName };
}

export async function createEchoConversation(input: {
  palId: string;
  conversationName: string;
}): Promise<TavusConversation> {
  const response = await fetch(`${API}/conversations`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      pal_id: input.palId,
      conversation_name: input.conversationName,
    }),
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    logger.error("facetime.conversation_rejected", {
      status: response.status,
      code: safeError(detail),
    });
    throw new Error(`Tavus conversation rejected: ${response.status}`);
  }

  const body = (await response.json().catch(() => null)) as {
    conversation_id?: string;
    conversation_url?: string;
  } | null;

  const conversationId = body?.conversation_id ?? "";
  const conversationUrl = body?.conversation_url ?? "";
  if (!conversationId || !conversationUrl) {
    throw new Error("Tavus conversation returned no join url");
  }

  return { conversationId, conversationUrl };
}

export async function endEchoConversation(conversationId: string): Promise<void> {
  const response = await fetch(`${API}/conversations/${conversationId}/end`, {
    method: "POST",
    headers: headers(),
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });

  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => "");
    logger.error("facetime.conversation_end_rejected", {
      status: response.status,
      code: safeError(detail),
    });
  }
}

function safeError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: string;
      message?: string;
    };
    return parsed.error ?? parsed.message ?? "unknown";
  } catch {
    return "unparseable";
  }
}
