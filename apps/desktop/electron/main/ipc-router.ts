import {
  ipcChannels,
  isIpcChannel,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
} from "@social-explorer/contracts";
import type { Logger } from "@social-explorer/security";
import type { IpcEnvelope, IpcFailure } from "../../shared/bridge.js";

export class UnsupportedIpcError extends Error {}

/** A handler rejection whose message is authored by us and safe to show the renderer. */
export class IpcRejectedError extends Error {}

export type IpcHandlers = {
  readonly [C in IpcChannel]?: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>;
};

export interface IpcRouter {
  handle(
    channel: unknown,
    payload: unknown,
    senderUrl: string | undefined,
  ): Promise<IpcEnvelope<unknown>>;
}

export interface IpcRouterOptions {
  readonly handlers: IpcHandlers;
  readonly isTrustedSender: (senderUrl: string | undefined) => boolean;
  readonly logger?: Logger;
}

function fail(code: IpcFailure["code"], message: string): IpcEnvelope<never> {
  return { ok: false, error: { code, message } };
}

/**
 * Validates every renderer call: channel allow-list, sender origin, strict request schema, and
 * strict response schema. Errors are reduced to a code + generic message (no stacks or paths).
 */
export function createIpcRouter(options: IpcRouterOptions): IpcRouter {
  return {
    async handle(channel, payload, senderUrl) {
      if (typeof channel !== "string" || !isIpcChannel(channel)) {
        options.logger?.warn("ipc rejected: unknown channel");
        return fail("UNKNOWN_CHANNEL", "unknown channel");
      }
      if (!options.isTrustedSender(senderUrl)) {
        options.logger?.warn("ipc rejected: untrusted sender", { channel });
        return fail("UNTRUSTED_SENDER", "untrusted sender");
      }
      const contract = ipcChannels[channel];
      const request = contract.request.safeParse(payload);
      if (!request.success) {
        return fail("INVALID_REQUEST", "request failed validation");
      }
      const handler = options.handlers[channel] as ((request: unknown) => unknown) | undefined;
      if (handler === undefined) {
        return fail("UNSUPPORTED", "channel not available yet");
      }
      try {
        const result = await handler(request.data);
        const response = contract.response.safeParse(result);
        if (!response.success) {
          options.logger?.error("ipc handler produced invalid response", { channel });
          return fail("INVALID_RESPONSE", "response failed validation");
        }
        return { ok: true, value: response.data };
      } catch (error) {
        if (error instanceof UnsupportedIpcError) {
          return fail("UNSUPPORTED", "channel not available yet");
        }
        if (error instanceof IpcRejectedError) {
          return fail("INVALID_REQUEST", error.message);
        }
        options.logger?.error("ipc handler failed", { channel, error });
        return fail("INTERNAL_ERROR", "internal error");
      }
    },
  };
}
