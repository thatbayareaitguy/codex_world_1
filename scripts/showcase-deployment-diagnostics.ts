// Classify only known CLI failure categories. Never persist CLI output or extracted URLs.
export function deploymentFailure(output: string): Error {
  if (
    /not authenticated|authentication required|token.*(?:invalid|expired)|please.*(?:login|log in)|vercel login|login expired/i.test(
      output,
    )
  )
    return new Error("Vercel authentication failed.");
  if (/file size limit exceeded|request entity too large|payload too large/i.test(output))
    return new Error("Vercel upload exceeded its limit.");
  if (
    /build failed|build.*exited with|command.*exited with|type error:|failed to compile/i.test(
      output,
    )
  )
    return new Error("Vercel build failed.");
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network error/i.test(output))
    return new Error("Vercel network request failed.");
  return new Error("Vercel deployment failed.");
}
