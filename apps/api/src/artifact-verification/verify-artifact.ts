import { createHash } from "node:crypto";

export type ArtifactVerificationInput = {
  storageUri: string;
  expectedSha256: string;
  expectedSizeBytes: number;
  producerWorkerId: string;
};

export type ReadArtifact = (storageUri: string) => Promise<Uint8Array>;

export type ArtifactVerificationResult =
  | {
      ok: true;
      actualSha256: string;
      // Pass these verified bytes directly to the model runner without rereading the file.
      bytes: Uint8Array;
    }
  | {
      ok: false;
      reason:
        | "UNTRUSTED_WORKER"
        | "ARTIFACT_NOT_FOUND"
        | "SIZE_MISMATCH"
        | "CHECKSUM_MISMATCH";
      message: string;
    };

export function verifyWorkerProvenance(
  producerWorkerId: string,
  trustedWorkerIds: ReadonlySet<string>,
): ArtifactVerificationResult | null {
  if (trustedWorkerIds.has(producerWorkerId)) {
    return null;
  }

  return {
    ok: false,
    reason: "UNTRUSTED_WORKER",
    message: `Artifact producer '${producerWorkerId}' is not trusted`,
  };
}

export async function verifyArtifact(
  input: ArtifactVerificationInput,
  trustedWorkerIds: ReadonlySet<string>,
  readArtifact: ReadArtifact,
): Promise<ArtifactVerificationResult> {
  const provenanceFailure = verifyWorkerProvenance(
    input.producerWorkerId,
    trustedWorkerIds,
  );

  if (provenanceFailure) {
    return provenanceFailure;
  }

  let bytes: Uint8Array;

  try {
    bytes = await readArtifact(input.storageUri);
  } catch {
    return {
      ok: false,
      reason: "ARTIFACT_NOT_FOUND",
      message: "The model artifact could not be read",
    };
  }

  if (bytes.byteLength !== input.expectedSizeBytes) {
    return {
      ok: false,
      reason: "SIZE_MISMATCH",
      message: `Expected ${input.expectedSizeBytes} bytes but found ${bytes.byteLength}`,
    };
  }

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");

  if (actualSha256 !== input.expectedSha256) {
    return {
      ok: false,
      reason: "CHECKSUM_MISMATCH",
      message: "The model artifact checksum does not match its stored checksum",
    };
  }

  return {
    ok: true,
    actualSha256,
    bytes,
  };
}
