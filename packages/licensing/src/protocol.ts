import { z } from "zod";

/**
 * Wire contract for licensing. Every request schema is strict: unknown fields are rejected, so
 * chat content, file names or any other user data cannot ride along by accident.
 */
const LicenseKey = z.string().regex(/^SE-[A-Z0-9]{5}(?:-[A-Z0-9]{5}){3}$/u);
const DeviceId = z.string().regex(/^[a-f0-9]{64}$/u);
const AppVersion = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.]{1,20})?$/u);
const Platform = z.enum(["win32", "darwin", "linux"]);

export const ActivateRequestSchema = z.strictObject({
  licenseKey: LicenseKey,
  deviceId: DeviceId,
  appVersion: AppVersion,
  platform: Platform,
});
export const RefreshRequestSchema = z.strictObject({
  licenseKey: LicenseKey,
  deviceId: DeviceId,
  appVersion: AppVersion,
});
export const DeactivateRequestSchema = z.strictObject({
  licenseKey: LicenseKey,
  deviceId: DeviceId,
});
export const TokenResponseSchema = z.strictObject({ token: z.string().min(1).max(8192) });

export const LicenseErrorCodeSchema = z.enum([
  "invalid_request",
  "license_not_found",
  "license_revoked",
  "license_expired",
  "device_limit_reached",
  "device_not_registered",
  "not_found",
  "payload_too_large",
  "internal_error",
]);
export type LicenseErrorCode = z.infer<typeof LicenseErrorCodeSchema>;
export const ErrorResponseSchema = z.strictObject({ error: LicenseErrorCodeSchema });

export type ActivateRequest = z.infer<typeof ActivateRequestSchema>;
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
export type DeactivateRequest = z.infer<typeof DeactivateRequestSchema>;
