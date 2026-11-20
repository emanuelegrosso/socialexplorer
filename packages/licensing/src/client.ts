import { z } from "zod";
import { deriveDeviceId, generateInstallSecret } from "./device.js";
import { evaluateEntitlement, freeEntitlement, type EffectiveEntitlement } from "./entitlement.js";
import {
  ErrorResponseSchema,
  TokenResponseSchema,
  type ActivateRequest,
  type DeactivateRequest,
  type LicenseErrorCode,
  type RefreshRequest,
} from "./protocol.js";
import { TokenError, verifyEntitlementToken } from "./token.js";

/** Structural match for @social-explorer/security ProtectedStore (JSON subset). */
export interface ProtectedStoreLike {
  setJson(name: string, value: unknown): Promise<void>;
  getJson<T>(name: string): Promise<T | undefined>;
  remove(name: string): Promise<void>;
}

const StoredStateSchema = z.object({
  installSecret: z.string().regex(/^[a-f0-9]{64}$/u),
  licenseKey: z.string().optional(),
  token: z.string().optional(),
});
export type StoredLicenseState = z.infer<typeof StoredStateSchema>;

export interface LicenseStorage {
  load(): Promise<StoredLicenseState | undefined>;
  save(state: StoredLicenseState): Promise<void>;
}

const STORE_KEY = "licensing/state";

export function createProtectedLicenseStorage(store: ProtectedStoreLike): LicenseStorage {
  return {
    async load() {
      const raw = await store.getJson<unknown>(STORE_KEY).catch(() => undefined);
      const parsed = StoredStateSchema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    },
    async save(state) {
      await store.setJson(STORE_KEY, state);
    },
  };
}

export function createMemoryLicenseStorage(): LicenseStorage {
  let state: StoredLicenseState | undefined;
  return {
    load: () => Promise.resolve(state),
    save: (next) => {
      state = next;
      return Promise.resolve();
    },
  };
}

export class LicenseServerError extends Error {
  constructor(readonly code: LicenseErrorCode) {
    super(`License server error: ${code}`);
    this.name = "LicenseServerError";
  }
}

/** Throws on network failure; resolves with HTTP status and parsed JSON otherwise. */
export type LicenseTransport = (
  path: string,
  body: unknown,
) => Promise<{ readonly status: number; readonly body: unknown }>;

export function createFetchTransport(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): LicenseTransport {
  return async (path, body) => {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed: unknown = await response.json().catch(() => null);
    return { status: response.status, body: parsed };
  };
}

export interface LicensingClientOptions {
  readonly transport: LicenseTransport;
  readonly storage: LicenseStorage;
  readonly publicKeyPem: string;
  readonly appVersion: string;
  readonly platform: ActivateRequest["platform"];
  readonly now?: () => number;
}

export type RefreshOutcome =
  | { readonly kind: "refreshed"; readonly entitlement: EffectiveEntitlement }
  | { readonly kind: "offline"; readonly entitlement: EffectiveEntitlement }
  | {
      readonly kind: "rejected";
      readonly code: LicenseErrorCode;
      readonly entitlement: EffectiveEntitlement;
    };

export class LicensingClient {
  private readonly now: () => number;

  constructor(private readonly options: LicensingClientOptions) {
    this.now = options.now ?? Date.now;
  }

  async getDeviceId(): Promise<string> {
    return deriveDeviceId((await this.ensureState()).installSecret);
  }

  /** Current effective entitlement; never throws and never reports less than full data access. */
  async current(): Promise<EffectiveEntitlement> {
    const state = await this.options.storage.load();
    if (state?.token === undefined) {
      return freeEntitlement();
    }
    try {
      const payload = verifyEntitlementToken(state.token, {
        publicKeyPem: this.options.publicKeyPem,
        expectedDeviceId: deriveDeviceId(state.installSecret),
      });
      return evaluateEntitlement(payload, this.now());
    } catch (error) {
      if (error instanceof TokenError) {
        return freeEntitlement();
      }
      throw error;
    }
  }

  async activate(licenseKey: string): Promise<EffectiveEntitlement> {
    const state = await this.ensureState();
    const request: ActivateRequest = {
      licenseKey,
      deviceId: deriveDeviceId(state.installSecret),
      appVersion: this.options.appVersion,
      platform: this.options.platform,
    };
    const token = await this.callForToken("/v1/licenses/activate", request);
    await this.options.storage.save({ ...state, licenseKey, token });
    return this.current();
  }

  async refresh(): Promise<RefreshOutcome> {
    const state = await this.ensureState();
    if (state.licenseKey === undefined) {
      return { kind: "rejected", code: "license_not_found", entitlement: freeEntitlement() };
    }
    const request: RefreshRequest = {
      licenseKey: state.licenseKey,
      deviceId: deriveDeviceId(state.installSecret),
      appVersion: this.options.appVersion,
    };
    try {
      const token = await this.callForToken("/v1/licenses/refresh", request);
      await this.options.storage.save({ ...state, token });
      return { kind: "refreshed", entitlement: await this.current() };
    } catch (error) {
      if (error instanceof LicenseServerError) {
        await this.options.storage.save({
          installSecret: state.installSecret,
          licenseKey: state.licenseKey,
        });
        return { kind: "rejected", code: error.code, entitlement: freeEntitlement("expired") };
      }
      if (error instanceof TokenError) {
        return { kind: "rejected", code: "internal_error", entitlement: await this.current() };
      }
      return { kind: "offline", entitlement: await this.current() };
    }
  }

  /** Releases the device seat so the key can be activated elsewhere (transfer). Local data is untouched. */
  async deactivate(): Promise<EffectiveEntitlement> {
    const state = await this.ensureState();
    if (state.licenseKey !== undefined) {
      const request: DeactivateRequest = {
        licenseKey: state.licenseKey,
        deviceId: deriveDeviceId(state.installSecret),
      };
      await this.options.transport("/v1/licenses/deactivate", request);
    }
    await this.options.storage.save({ installSecret: state.installSecret });
    return freeEntitlement();
  }

  private async ensureState(): Promise<StoredLicenseState> {
    const existing = await this.options.storage.load();
    if (existing) {
      return existing;
    }
    const created: StoredLicenseState = { installSecret: generateInstallSecret() };
    await this.options.storage.save(created);
    return created;
  }

  private async callForToken(path: string, body: unknown): Promise<string> {
    const response = await this.options.transport(path, body);
    if (response.status >= 500) {
      throw new Error("licensing service unavailable");
    }
    if (response.status !== 200) {
      const parsed = ErrorResponseSchema.safeParse(response.body);
      throw new LicenseServerError(parsed.success ? parsed.data.error : "internal_error");
    }
    const parsed = TokenResponseSchema.parse(response.body);
    const state = await this.options.storage.load();
    verifyEntitlementToken(parsed.token, {
      publicKeyPem: this.options.publicKeyPem,
      ...(state ? { expectedDeviceId: deriveDeviceId(state.installSecret) } : {}),
    });
    return parsed.token;
  }
}
