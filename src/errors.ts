export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";

/** What the app should do about an error. */
export type Recovery =
  | "sign_in" // no usable credentials; run signIn()
  | "enable_plan" // signed in, but plan usage was not granted; signIn({ forceConsent: true })
  | "manage_usage" // usage limit hit; send the user to MANAGE_USAGE_URL
  | "retry_later" // transient; keep credentials, back off
  | "fix_request" // the request body/route is not supported by this flow
  | "not_eligible" // the user/workspace cannot use plan usage
  | "none";

const RECOVERY_BY_CODE: Record<string, Recovery> = {
  not_signed_in: "sign_in",
  reauth_required: "sign_in",
  plan_not_enabled: "enable_plan",
  access_denied: "enable_plan",
  subscription_sharing_usage_limit_exceeded: "manage_usage",
  subscription_sharing_usage_unavailable: "retry_later",
  subscription_sharing_user_unavailable: "retry_later",
  subscription_sharing_user_not_eligible: "not_eligible",
  subscription_sharing_unsupported_capability: "fix_request",
  subscription_sharing_route_not_supported: "fix_request",
  subscription_sharing_invalid_user: "sign_in",
  chatpass_v2_scope_not_authorized: "fix_request",
  chatpass_v2_invalid_authorization_context: "fix_request",
};

export interface PlanErrorInit {
  status?: number;
  requestId?: string;
  param?: string;
  recovery?: Recovery;
  cause?: unknown;
}

export class PlanError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly param?: string;
  readonly recovery: Recovery;

  constructor(code: string, message: string, init: PlanErrorInit = {}) {
    super(message, { cause: init.cause });
    this.name = "PlanError";
    this.code = code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.param = init.param;
    this.recovery = init.recovery ?? RECOVERY_BY_CODE[code] ?? recoveryFromStatus(init.status);
  }

  /** True when retrying the same request later may succeed. */
  get retryable(): boolean {
    return this.recovery === "retry_later";
  }

  get manageUsageUrl(): string {
    return MANAGE_USAGE_URL;
  }
}

function recoveryFromStatus(status?: number): Recovery {
  if (status === undefined) return "none";
  if (status === 401) return "sign_in";
  if (status === 429 || status >= 500) return "retry_later";
  return "none";
}

/** Build a PlanError from a non-2xx API response. Handles both `{error:{...}}` and `{detail}` bodies. */
export async function errorFromResponse(res: Response): Promise<PlanError> {
  const requestId = res.headers.get("x-request-id") ?? undefined;
  const text = await res.text().catch(() => "");
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const err = body?.error;
  if (err && typeof err === "object") {
    return new PlanError(err.code ?? `http_${res.status}`, err.message ?? text, {
      status: res.status,
      requestId,
      param: err.param ?? undefined,
    });
  }
  // Direct-admission failures may return `{ detail }` before any Responses request starts.
  const detail = typeof body?.detail === "string" ? body.detail : text || res.statusText;
  return new PlanError(`http_${res.status}`, detail, { status: res.status, requestId });
}
