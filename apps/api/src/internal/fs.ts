import { createHash } from "node:crypto";
import { mkdir, link, open, rm, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type PromotedArtifact = {
  storageUri: string;
  absolutePath: string;
};

export type TempArtifactResolution =
  | { ok: true; absolutePath: string }
  | { ok: false; reason: "TEMP_URI_INVALID"; message: string };

const MODEL_DIRECTORY_PREFIX = "models/";

/**
 * Resolves the worker's temporary artifact URI strictly inside the shared
 * storage root. Absolute URIs, traversal segments, and anything under the
 * immutable models/ tree are rejected before any filesystem work happens.
 */
export function resolveTempArtifactPath(
  storageRoot: string,
  storageUri: string,
): TempArtifactResolution {
  if (
    storageUri.length === 0 ||
    isAbsolute(storageUri) ||
    storageUri.startsWith(MODEL_DIRECTORY_PREFIX)
  ) {
    return {
      ok: false,
      reason: "TEMP_URI_INVALID",
      message:
        "The result artifact URI must be a relative temporary file name",
    };
  }

  const root = resolve(storageRoot);
  const candidate = resolve(root, storageUri);
  const relativePath = relative(root, candidate);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return {
      ok: false,
      reason: "TEMP_URI_INVALID",
      message: "The result artifact URI points outside the storage root",
    };
  }

  return { ok: true, absolutePath: candidate };
}

/**
 * Builds the immutable versioned path for one candidate artifact.
 */
export function buildModelArtifactPath(
  storageRoot: string,
  datasetDefinitionId: string,
  versionNumber: number,
  trainingJobId: string,
): string {
  return resolve(
    storageRoot,
    `models/${datasetDefinitionId}/v${versionNumber}/${trainingJobId}.onnx`,
  );
}

export type PromotionResult = { ok: true } | { ok: false; message: string };

/**
 * Promotes the verified temporary payload to its immutable path with a
 * no-clobber hard link followed by an unlink of the temporary name. An
 * existing final path is never overwritten. Once the link exists the
 * promotion has happened, so a failing temporary-name cleanup is only
 * logged; reporting it as a failure would strand the promoted file
 * outside the caller's cleanup tracking.
 */
export async function promoteArtifact(
  tempPath: string,
  finalPath: string,
): Promise<PromotionResult> {
  try {
    await mkdir(dirname(resolve(finalPath)), { recursive: true });
    await link(tempPath, finalPath);
  } catch (error) {
    if (isAlreadyLinked(error)) {
      return {
        ok: false,
        message: "The immutable model artifact path already exists",
      };
    }
    return {
      ok: false,
      message: "The model artifact could not be promoted to immutable storage",
    };
  }

  try {
    await unlink(tempPath);
  } catch (error) {
    console.warn(
      "The promoted model artifact could not remove its temporary payload",
      error,
    );
  }

  return { ok: true };
}

function isAlreadyLinked(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

export type ArtifactVerification =
  | { ok: true }
  | {
      ok: false;
      reason: "ARTIFACT_NOT_FOUND" | "SIZE_MISMATCH" | "CHECKSUM_MISMATCH";
      message: string;
    };

const VERIFY_CHUNK_BYTES = 1024 * 1024;

/**
 * Re-verifies the promoted final file against the validated payload
 * metadata using an incremental digest so the file is never held in memory
 * as a whole.
 */
export async function verifyPromotedArtifact(
  finalPath: string,
  expectedSha256: string,
  expectedSizeBytes: number,
): Promise<ArtifactVerification> {
  let size: number;

  try {
    size = (await stat(finalPath)).size;
  } catch {
    return {
      ok: false,
      reason: "ARTIFACT_NOT_FOUND",
      message: "The promoted model artifact is not present",
    };
  }

  if (size !== expectedSizeBytes) {
    return {
      ok: false,
      reason: "SIZE_MISMATCH",
      message: "The promoted model artifact size does not match the payload",
    };
  }

  const digest = createHash("sha256");
  const file = await open(finalPath, "r");

  try {
    const chunk = Buffer.alloc(VERIFY_CHUNK_BYTES);

    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, VERIFY_CHUNK_BYTES, null);

      if (bytesRead === 0) {
        break;
      }

      digest.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }

  if (digest.digest("hex") !== expectedSha256) {
    return {
      ok: false,
      reason: "CHECKSUM_MISMATCH",
      message:
        "The promoted model artifact checksum does not match the payload",
    };
  }

  return { ok: true };
}

/**
 * Deletes a promoted or temporary artifact, tolerating an absent file.
 */
export async function deleteArtifact(path: string): Promise<void> {
  await rm(path, { force: true });
}
