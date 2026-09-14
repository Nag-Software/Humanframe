import type { ThreadMessageLike } from "@assistant-ui/react";
import type { EveMessage, EveMessagePart } from "eve/react";



type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

type ThreadContent = Extract<ThreadMessageLike["content"], readonly unknown[]>;
type ThreadPart = ThreadContent[number];

/**
 * eve's message projection follows the AI SDK UIMessage convention but is not
 * the same type, so this is the one place that translates it into what
 * assistant-ui renders. Everything downstream — the thread, the tool cards, the
 * approval card — keeps working unchanged.
 */
export function toThreadMessage(message: EveMessage): ThreadMessageLike {
  const content = message.parts
    .map(toThreadPart)
    .filter((part): part is ThreadPart => part !== null);

  return {
    id: message.id,
    role: message.role,
    content,
    status: toStatus(message),
    metadata: {
      custom: {
        turnId: message.metadata?.turnId,
        optimistic: message.metadata?.optimistic ?? false,
      },
    },
  };
}

function toStatus(message: EveMessage): ThreadMessageLike["status"] {
  if (message.role !== "assistant") {
    return undefined;
  }
  switch (message.metadata?.status) {
    case "streaming":
      return { type: "running" };
    case "failed":
      return { type: "incomplete", reason: "error" };
    default:
      return { type: "complete", reason: "stop" };
  }
}

function toThreadPart(part: EveMessagePart): ThreadPart | null {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        text: part.text,
        status:
          part.state === "streaming"
            ? { type: "running" }
            : { type: "complete" },
      };

    case "reasoning":
      return {
        type: "reasoning",
        text: part.text,
        status:
          part.state === "streaming"
            ? { type: "running" }
            : { type: "complete" },
      };

    case "file":
      // eve omits the url when the attachment is not browser-resolvable; there
      // is nothing to render in that case.
      if (!part.url) {
        return null;
      }
      return part.mediaType.startsWith("image/")
        ? { type: "image", image: part.url, filename: part.filename }
        : {
            type: "file",
            data: part.url,
            mimeType: part.mediaType,
            filename: part.filename,
            sourceType: "url",
          };

    case "dynamic-tool":
      return toToolCallPart(part);

    case "authorization":
      // A connection wants the user to sign in. Rendered as plain text until
      // the connections work in phase 5 gives it a proper card.
      return {
        type: "text",
        text:
          part.state === "required"
            ? (part.authorization?.instructions ??
              `${part.displayName} needs you to sign in.`)
            : `${part.displayName}: ${part.outcome}`,
      };

    // Step boundaries carry no content of their own.
    case "step-start":
      return null;

    default:
      return null;
  }
}

function toToolCallPart(
  part: Extract<EveMessagePart, { type: "dynamic-tool" }>
): ThreadPart {
  const base = {
    type: "tool-call" as const,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    // eve types tool input as `unknown`; assistant-ui wants a JSON object. The
    // value on the wire is already JSON, so this cast is a type bridge only.
    args: (part.input ?? {}) as JsonObject,
    argsText: part.state === "input-streaming" ? part.inputText : "",
  };

  const request = part.toolMetadata?.eve?.inputRequest;
  const approvalBase = request
    ? {
        prompt: request.prompt,
        display: toApprovalDisplay(request.display),
        allowFreeform: request.allowFreeform,
        options: request.options?.map((option) => ({
          id: option.id,
          kind: toOptionKind(option.id, option.style),
          label: option.label,
          description: option.description,
        })),
      }
    : {};

  switch (part.state) {
    case "approval-requested":
      return {
        ...base,
        approval: { id: part.approval.id, ...approvalBase },
      };

    case "approval-responded":
      return {
        ...base,
        approval: {
          id: part.approval.id,
          approved: part.approval.approved,
          reason: part.approval.reason,
          ...approvalBase,
        },
      };

    case "output-available":
      return { ...base, result: part.output };

    case "output-error":
      return { ...base, result: part.errorText, isError: true };

    case "output-denied":
      return {
        ...base,
        approval: {
          id: part.approval.id,
          approved: false,
          reason: part.approval.reason,
          ...approvalBase,
        },
      };

    default:
      return base;
  }
}

function toApprovalDisplay(
  display: "confirmation" | "select" | "text" | undefined
): "decision" | "select" | "text" | undefined {
  if (display === "confirmation") {
    return "decision";
  }
  return display;
}

/**
 * eve identifies an option by id and styles it; assistant-ui classifies it.
 * Ids that are not a plain allow/deny keep a custom kind, which the kit renders
 * without auto-resolving.
 */
function toOptionKind(
  id: string,
  style: "danger" | "default" | "primary" | undefined
): string {
  if (id === "approve" || id === "allow" || id === "yes") {
    return "allow-once";
  }
  if (id === "deny" || id === "reject" || id === "no") {
    return "reject-once";
  }
  return style === "danger" ? "reject-once" : `_${id}`;
}
