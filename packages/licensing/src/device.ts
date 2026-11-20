import { createHash, randomBytes } from "node:crypto";

/** Random per-installation secret; carries no hardware, user or machine-name information. */
export function generateInstallSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Pseudonymous device id: a one-way hash of the install secret. */
export function deriveDeviceId(installSecret: string): string {
  return createHash("sha256").update(`social-explorer:device:v1:${installSecret}`).digest("hex");
}
