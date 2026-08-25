import { Type } from "@sinclair/typebox";
import { Elysia } from "elysia";

import { getAuthContext, hasClaim, INVITE_USER_CLAIM } from "../auth/context";
import { resolveNucleusAuth } from "../auth/resolve-nucleus-auth";

const InviteTenantUserDto = Type.Object({
  email: Type.String({ format: "email" }),
});

export const tenantUserRoutes = new Elysia({ prefix: "/tenant-users" }).post(
  "/invite",
  async ({ body, request, set }) => {
    const auth =
      getAuthContext(request.headers) ?? (await resolveNucleusAuth(request));

    if (!auth) {
      set.status = 401;
      return {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      };
    }

    if (!hasClaim(auth, INVITE_USER_CLAIM)) {
      set.status = 403;
      return {
        error: {
          code: "FORBIDDEN",
          message: "Tenant administrator permission is required",
        },
      };
    }

    const response = await fetch(new URL("/auth/invite", request.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: request.headers.get("cookie") ?? "",
        "x-service-id": request.headers.get("x-service-id") ?? "",
        "x-tenant-id": request.headers.get("x-tenant-id") ?? "",
      },
      body: JSON.stringify(body),
    });

    set.status = response.status;
    return response.json();
  },
  { body: InviteTenantUserDto },
);
