export const PUBLISH_MODEL_CLAIM = "publish.model_versions";
export const CREATE_DATASET_CLAIM = "create.dataset_definitions";
export const GENERATE_TOOL_DEFINITION_CLAIM = "generate.tool_definitions";
export const INVOKE_TOOL_CLAIM = "invoke.tool_definitions";
export const CREATE_TRAINING_JOB_CLAIM = "create.training_jobs";
export const CANCEL_TRAINING_JOB_CLAIM = "cancel.training_jobs";
export const RETIRE_MODEL_CLAIM = "retire.model_versions";
export const INVITE_USER_CLAIM = "invite.users";

export type AuthContext = {
  userId: string;
  schemaName: string;
  claims: string[];
  authType: string;
};

export function getAuthContext(headers: Headers): AuthContext | null {
  const userId = headers.get("x-user-id");
  const schemaName = headers.get("x-tenant-schema");
  const authType = headers.get("x-auth-type");

  if (!userId || !schemaName || !authType) {
    return null;
  }

  return {
    userId,
    schemaName,
    authType,
    claims: decodeClaims(headers.get("x-user-claims")),
  };
}

export function hasClaim(context: AuthContext, requiredClaim: string): boolean {
  return context.claims.includes("*") || context.claims.includes(requiredClaim);
}

function decodeClaims(header: string | null): string[] {
  if (!header) {
    return [];
  }

  return header.split(",").map((claim) => {
    try {
      return decodeURIComponent(claim);
    } catch {
      return claim;
    }
  });
}
