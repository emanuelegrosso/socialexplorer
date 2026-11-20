import type { MediaAsset, MediaReference } from "@social-explorer/contracts";

export type MediaAvailability = MediaAsset["availability"];
export type MediaKind = MediaAsset["kind"];

/**
 * A MediaAsset is a content-hashed physical file; a MediaReference is one message's link
 * to media plus a truthful availability state. Availability vocabulary used by the product:
 * available (`available-local`), missing, not-imported, unsupported (plus `external-link`).
 */
export type ProductAvailability = "available" | "missing" | "not-imported" | "unsupported";

export function toProductAvailability(value: MediaAvailability): ProductAvailability {
  switch (value) {
    case "available-local":
      return "available";
    case "external-link":
      return "not-imported";
    default:
      return value;
  }
}

export type CatalogMediaType = "photo" | "video" | "audio" | "voice-note" | "document";

const CATALOG_TO_KIND: Readonly<Record<CatalogMediaType, MediaKind>> = {
  photo: "image",
  video: "video",
  audio: "audio",
  "voice-note": "voice",
  document: "document",
};

export function catalogMediaTypeToKind(type: CatalogMediaType): MediaKind {
  return CATALOG_TO_KIND[type];
}

export function kindToCatalogMediaType(kind: MediaKind): CatalogMediaType | undefined {
  return (Object.keys(CATALOG_TO_KIND) as CatalogMediaType[]).find(
    (type) => CATALOG_TO_KIND[type] === kind,
  );
}

export class MediaInvariantError extends Error {
  override readonly name = "MediaInvariantError";
}

/** Asset invariants: local availability requires hashed bytes in managed storage. */
export function assertAssetInvariants(asset: MediaAsset): void {
  if (asset.availability === "available-local") {
    if (asset.storageRelativePath === undefined || asset.contentHash === undefined) {
      throw new MediaInvariantError("Available assets need contentHash and storageRelativePath");
    }
  } else if (asset.storageRelativePath !== undefined) {
    throw new MediaInvariantError("Only available-local assets may own a managed copy");
  }
  if (asset.storageRelativePath !== undefined) {
    const expectedPrefix = `media/${(asset.contentHash ?? "").slice(0, 2)}/${asset.contentHash ?? ""}.`;
    if (!asset.storageRelativePath.startsWith(expectedPrefix)) {
      throw new MediaInvariantError("Managed path must be derived from the content hash");
    }
  }
}

/** Reference invariants: only references without bytes may be missing/unsupported. */
export function assertReferenceInvariants(reference: MediaReference, asset?: MediaAsset): void {
  const needsAsset =
    reference.availability === "available-local" || reference.availability === "external-link";
  if (needsAsset && reference.mediaAssetId === undefined) {
    throw new MediaInvariantError(`${reference.availability} references need a media asset`);
  }
  if (reference.availability === "missing" && reference.mediaAssetId !== undefined) {
    throw new MediaInvariantError("Missing references must not point at an asset");
  }
  if (
    reference.availability === "available-local" &&
    asset !== undefined &&
    asset.availability !== "available-local"
  ) {
    throw new MediaInvariantError("Reference claims availability its asset does not have");
  }
}
