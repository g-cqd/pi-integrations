/** Safe hints, never provider-supplied descriptions or account identifiers. */
export function inferenceError(status: number): string {
 const hint = status === 401 ? "Session expired or revoked; run /login for copilot-vscode."
  : status === 402 ? "Check your Copilot billing allowance and additional-usage budget."
  : status === 403 ? "Access denied; check account entitlement and organization/model policy."
  : status === 429 ? "Copilot quota or rate limit reached; wait and check your allowance."
  : status >= 500 ? "Copilot service is temporarily unavailable; try again later."
  : "Check model support and request options.";
 return `Copilot request returned HTTP ${status}. ${hint}`;
}

export function safeErrorHeaders(headers: Headers): Headers {
 const safe = new Headers({ "content-type": "application/json" });
 // SDKs may surface arbitrary response headers in exceptions. Keep only a
 // validated retry delay; never retain content-length/encoding for a new body.
 const retry = headers.get("retry-after");
 if (retry && /^\d{1,6}$/.test(retry)) safe.set("retry-after", retry);
 return safe;
}
