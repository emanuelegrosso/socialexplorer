import { createHash, randomBytes } from "node:crypto";
import {
  PLAN_DEFINITIONS,
  buildEntitlementPayload,
  signEntitlement,
  type ActivateRequest,
  type DeactivateRequest,
  type LicenseErrorCode,
  type Plan,
  type RefreshRequest,
} from "@social-explorer/licensing";
import type { LicenseRecord, LicenseRepository } from "./repository.js";

const DAY = 86_400_000;

export class LicenseServiceError extends Error {
  constructor(readonly code: LicenseErrorCode) {
    super(code);
    this.name = "LicenseServiceError";
  }
}

export interface LicensingServiceOptions {
  readonly repository: LicenseRepository;
  readonly privateKeyPem: string;
  readonly now?: () => number;
  readonly tokenTtlMs?: number;
  readonly offlineGraceMs?: number;
  /** How long after licence expiry updates remain eligible (perpetual-fallback for older builds). */
  readonly updatesWindowMs?: number;
}

export const hashLicenseKey = (key: string): string =>
  createHash("sha256").update(key).digest("hex");

function generateLicenseKey(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () =>
    Array.from(randomBytes(5), (b) => alphabet.charAt(b % alphabet.length)).join("");
  return `SE-${group()}-${group()}-${group()}-${group()}`;
}

export interface IssueLicenseInput {
  readonly plan: Exclude<Plan, "free">;
  readonly subscriptionRef: string;
  readonly customerRef: string;
  readonly expiresAt: number;
}

export class LicensingService {
  private readonly repo: LicenseRepository;
  private readonly now: () => number;
  private readonly tokenTtlMs: number;
  private readonly offlineGraceMs: number;
  private readonly updatesWindowMs: number;

  constructor(private readonly options: LicensingServiceOptions) {
    this.repo = options.repository;
    this.now = options.now ?? Date.now;
    this.tokenTtlMs = options.tokenTtlMs ?? 7 * DAY;
    this.offlineGraceMs = options.offlineGraceMs ?? 14 * DAY;
    this.updatesWindowMs = options.updatesWindowMs ?? 0;
  }

  /** Returns the plaintext key once; only its hash is stored. */
  async issueLicense(
    input: IssueLicenseInput,
  ): Promise<{ licenseKey: string; record: LicenseRecord }> {
    const licenseKey = generateLicenseKey();
    const record: LicenseRecord = {
      licenseId: `lic_${randomBytes(9).toString("base64url")}`,
      keyHash: hashLicenseKey(licenseKey),
      plan: input.plan,
      status: "active",
      expiresAt: input.expiresAt,
      subscriptionRef: input.subscriptionRef,
      customerRef: input.customerRef,
      devices: [],
      createdAt: this.now(),
    };
    await this.repo.insert(record);
    return { licenseKey, record };
  }

  async extend(subscriptionRef: string, expiresAt: number): Promise<LicenseRecord | undefined> {
    const record = await this.repo.findBySubscriptionRef(subscriptionRef);
    if (!record || record.status === "revoked") {
      return undefined;
    }
    const next = {
      ...record,
      status: "active" as const,
      expiresAt: Math.max(record.expiresAt, expiresAt),
    };
    await this.repo.update(next);
    return next;
  }

  /** Cancel stops renewal; entitlement runs to the paid period end. */
  async cancel(subscriptionRef: string): Promise<LicenseRecord | undefined> {
    const record = await this.repo.findBySubscriptionRef(subscriptionRef);
    if (!record || record.status === "revoked") {
      return undefined;
    }
    const next = { ...record, status: "canceled" as const };
    await this.repo.update(next);
    return next;
  }

  async revoke(subscriptionRef: string): Promise<LicenseRecord | undefined> {
    const record = await this.repo.findBySubscriptionRef(subscriptionRef);
    if (!record) {
      return undefined;
    }
    const next = { ...record, status: "revoked" as const };
    await this.repo.update(next);
    return next;
  }

  async activate(request: ActivateRequest): Promise<string> {
    const record = await this.loadUsable(request.licenseKey);
    if (!record.devices.includes(request.deviceId)) {
      if (record.devices.length >= PLAN_DEFINITIONS[record.plan].maxDevices) {
        throw new LicenseServiceError("device_limit_reached");
      }
      await this.repo.update({ ...record, devices: [...record.devices, request.deviceId] });
    }
    return this.mint(record, request.deviceId);
  }

  async refresh(request: RefreshRequest): Promise<string> {
    const record = await this.loadUsable(request.licenseKey);
    if (!record.devices.includes(request.deviceId)) {
      throw new LicenseServiceError("device_not_registered");
    }
    return this.mint(record, request.deviceId);
  }

  async deactivate(request: DeactivateRequest): Promise<void> {
    const record = await this.repo.findByKeyHash(hashLicenseKey(request.licenseKey));
    if (!record) {
      throw new LicenseServiceError("license_not_found");
    }
    await this.repo.update({
      ...record,
      devices: record.devices.filter((d) => d !== request.deviceId),
    });
  }

  private async loadUsable(licenseKey: string): Promise<LicenseRecord> {
    const record = await this.repo.findByKeyHash(hashLicenseKey(licenseKey));
    if (!record) {
      throw new LicenseServiceError("license_not_found");
    }
    if (record.status === "revoked") {
      throw new LicenseServiceError("license_revoked");
    }
    if (this.now() > record.expiresAt) {
      throw new LicenseServiceError("license_expired");
    }
    return record;
  }

  private mint(record: LicenseRecord, deviceId: string): string {
    const payload = buildEntitlementPayload({
      licenseId: record.licenseId,
      deviceId,
      plan: record.plan,
      now: this.now(),
      licenseExpiresAt: record.expiresAt,
      tokenTtlMs: this.tokenTtlMs,
      offlineGraceMs: this.offlineGraceMs,
      updatesUntil: record.expiresAt + this.updatesWindowMs,
    });
    return signEntitlement(payload, this.options.privateKeyPem);
  }
}
