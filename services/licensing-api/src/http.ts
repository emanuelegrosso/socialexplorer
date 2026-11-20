import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ActivateRequestSchema,
  DeactivateRequestSchema,
  RefreshRequestSchema,
  type LicenseErrorCode,
} from "@social-explorer/licensing";
import { LicenseServiceError, type LicensingService } from "./service.js";
import {
  MorEventSchema,
  verifyWebhookSignature,
  WebhookVerificationError,
  type MorEvent,
  type WebhookResult,
} from "./webhook.js";

const MAX_BODY_BYTES = 16 * 1024;

export interface LicensingServerOptions {
  readonly service: LicensingService;
  readonly webhook?: {
    readonly secrets: readonly string[];
    readonly handle: (event: MorEvent) => Promise<WebhookResult>;
  };
  readonly now?: () => number;
}

const STATUS: Record<LicenseErrorCode, number> = {
  invalid_request: 400,
  license_not_found: 404,
  license_revoked: 403,
  license_expired: 403,
  device_limit_reached: 409,
  device_not_registered: 403,
  not_found: 404,
  payload_too_large: 413,
  internal_error: 500,
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const fail = (res: ServerResponse, code: LicenseErrorCode): void => {
  send(res, STATUS[code], { error: code });
};

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function createLicensingServer(options: LicensingServerOptions): Server {
  const now = options.now ?? Date.now;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/health") {
      send(res, 200, { status: "ok" });
      return;
    }
    if (req.method !== "POST") {
      fail(res, "not_found");
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      fail(res, "payload_too_large");
      return;
    }
    const json = parseJson(raw);
    switch (path) {
      case "/v1/licenses/activate": {
        const parsed = ActivateRequestSchema.safeParse(json);
        if (!parsed.success) {
          fail(res, "invalid_request");
          return;
        }
        send(res, 200, { token: await options.service.activate(parsed.data) });
        return;
      }
      case "/v1/licenses/refresh": {
        const parsed = RefreshRequestSchema.safeParse(json);
        if (!parsed.success) {
          fail(res, "invalid_request");
          return;
        }
        send(res, 200, { token: await options.service.refresh(parsed.data) });
        return;
      }
      case "/v1/licenses/deactivate": {
        const parsed = DeactivateRequestSchema.safeParse(json);
        if (!parsed.success) {
          fail(res, "invalid_request");
          return;
        }
        await options.service.deactivate(parsed.data);
        send(res, 200, { status: "deactivated" });
        return;
      }
      case "/v1/webhooks/mor": {
        if (!options.webhook) {
          fail(res, "not_found");
          return;
        }
        const header = req.headers["x-signature"];
        try {
          verifyWebhookSignature({
            rawBody: raw,
            signatureHeader: typeof header === "string" ? header : undefined,
            secrets: options.webhook.secrets,
            now: now(),
          });
        } catch (error) {
          if (error instanceof WebhookVerificationError) {
            send(res, 401, { error: "invalid_signature" });
            return;
          }
          throw error;
        }
        const event = MorEventSchema.safeParse(json);
        if (!event.success) {
          fail(res, "invalid_request");
          return;
        }
        send(res, 200, { result: await options.webhook.handle(event.data) });
        return;
      }
      default:
        fail(res, "not_found");
    }
  }

  return createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      fail(res, error instanceof LicenseServiceError ? error.code : "internal_error");
    });
  });
}
