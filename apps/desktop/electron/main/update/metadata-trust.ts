import { z } from "zod";

/** Subset of electron-updater `UpdateInfo` fields we validate before trusting metadata. */
const UpdateFileSchema = z.strictObject({
  url: z.url(),
  sha512: z.string().min(64),
  size: z.number().int().positive().optional(),
});

export const TrustedUpdateMetadataSchema = z.strictObject({
  version: z.string().min(1).max(64),
  releaseDate: z.string().min(1),
  releaseNotes: z.union([z.string(), z.array(z.string())]).optional(),
  path: z.string().optional(),
  sha512: z.string().min(64).optional(),
  files: z.array(UpdateFileSchema).min(1).optional(),
});

export type TrustedUpdateMetadata = z.infer<typeof TrustedUpdateMetadataSchema>;

export type MetadataTrustResult =
  | { readonly ok: true; readonly metadata: TrustedUpdateMetadata }
  | { readonly ok: false; readonly reason: MetadataTrustFailure };

export type MetadataTrustFailure =
  | "malformed_metadata"
  | "missing_digest"
  | "untrusted_publisher";

export interface MetadataTrustOptions {
  /** When true, reject metadata that lacks sha512 digests on every artifact. */
  readonly requireSha512: boolean;
  /** When set, metadata must include this publisher attestation (e.g. CI signing job id). */
  readonly expectedPublisherAttestation?: string | undefined;
  readonly publisherAttestation?: string | undefined;
}

export function validateUpdateMetadataTrust(
  raw: unknown,
  options: MetadataTrustOptions,
): MetadataTrustResult {
  const parsed = TrustedUpdateMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "malformed_metadata" };
  }
  const metadata = parsed.data;
  const digests = collectDigests(metadata);
  if (options.requireSha512 && digests.length === 0) {
    return { ok: false, reason: "missing_digest" };
  }
  if (options.expectedPublisherAttestation !== undefined) {
    if (options.publisherAttestation !== options.expectedPublisherAttestation) {
      return { ok: false, reason: "untrusted_publisher" };
    }
  }
  return { ok: true, metadata };
}

function collectDigests(metadata: TrustedUpdateMetadata): string[] {
  const out: string[] = [];
  if (metadata.sha512 !== undefined) {
    out.push(metadata.sha512);
  }
  for (const file of metadata.files ?? []) {
    out.push(file.sha512);
  }
  return out;
}