/**
 * Same marker rules as api/_mcp-onboarding-policy.ts. Stdio cannot import
 * api/ (the Vercel bundle ignores src, and the package build cannot import
 * outside src). Tests lock the two copies to the same results.
 */
export type ProfileRead = "absent" | "onboarding" | "malformed";
export declare function readMcpProfile(identity: unknown): ProfileRead;
//# sourceMappingURL=mcp-profile.d.ts.map