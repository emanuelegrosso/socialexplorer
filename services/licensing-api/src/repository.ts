import type { Plan } from "@social-explorer/licensing";

export type LicenseStatus = "active" | "canceled" | "revoked";

/** Metadata only: no names, e-mail addresses, or chat data. `customerRef` is an opaque MoR id. */
export interface LicenseRecord {
  readonly licenseId: string;
  readonly keyHash: string;
  readonly plan: Plan;
  readonly status: LicenseStatus;
  readonly expiresAt: number;
  readonly subscriptionRef: string;
  readonly customerRef: string;
  readonly devices: readonly string[];
  readonly createdAt: number;
}

export interface LicenseRepository {
  insert(record: LicenseRecord): Promise<void>;
  findByKeyHash(keyHash: string): Promise<LicenseRecord | undefined>;
  findBySubscriptionRef(subscriptionRef: string): Promise<LicenseRecord | undefined>;
  update(record: LicenseRecord): Promise<void>;
  /** Atomically records an event id; returns false when it was already processed. */
  claimEvent(eventId: string): Promise<boolean>;
}

export class InMemoryLicenseRepository implements LicenseRepository {
  private readonly byId = new Map<string, LicenseRecord>();
  private readonly events = new Set<string>();

  insert(record: LicenseRecord): Promise<void> {
    this.byId.set(record.licenseId, record);
    return Promise.resolve();
  }
  findByKeyHash(keyHash: string): Promise<LicenseRecord | undefined> {
    return Promise.resolve([...this.byId.values()].find((r) => r.keyHash === keyHash));
  }
  findBySubscriptionRef(subscriptionRef: string): Promise<LicenseRecord | undefined> {
    return Promise.resolve(
      [...this.byId.values()].find((r) => r.subscriptionRef === subscriptionRef),
    );
  }
  update(record: LicenseRecord): Promise<void> {
    this.byId.set(record.licenseId, record);
    return Promise.resolve();
  }
  claimEvent(eventId: string): Promise<boolean> {
    if (this.events.has(eventId)) {
      return Promise.resolve(false);
    }
    this.events.add(eventId);
    return Promise.resolve(true);
  }
}
