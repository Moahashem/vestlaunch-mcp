/**
 * Same marker rules as api/_mcp-onboarding-policy.ts. Stdio cannot import
 * api/ (the Vercel bundle ignores src, and the package build cannot import
 * outside src). Tests lock the two copies to the same results.
 */
const ONBOARDING_PROFILE = "onboarding";
function plainIdentity(identity) {
    return identity !== null && typeof identity === "object" && !Array.isArray(identity);
}
export function readMcpProfile(identity) {
    if (!plainIdentity(identity))
        return "malformed";
    if (!Object.prototype.hasOwnProperty.call(identity, "mcpProfile"))
        return "absent";
    const value = identity.mcpProfile;
    if (value === ONBOARDING_PROFILE)
        return "onboarding";
    return "malformed";
}
//# sourceMappingURL=mcp-profile.js.map