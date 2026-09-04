// ============================================================
// FEATURE ACCESS
// ------------------------------------------------------------
// Roles are a ladder: site_admin > admin > member.
//   - site_admin: the topmost account. Implicitly has every
//     feature, is the only role that can create/demote admins,
//     and is the only role that can grant feature access.
//   - admin: day-to-day administration (users, tests, suites).
//   - member: whatever the site admin grants them.
//
// A user's `features` array overrides their role defaults. When
// it is absent they simply get their role's defaults, so adding
// a user never requires touching feature grants.
// ============================================================

export type Role = "site_admin" | "admin" | "member";

export const ROLES: Role[] = ["site_admin", "admin", "member"];

export const ROLE_LABELS: Record<Role, string> = {
  site_admin: "Site admin",
  admin: "Admin",
  member: "Member"
};

export interface FeatureSpec {
  id: string;
  label: string;
  description: string;
}

export const FEATURES: FeatureSpec[] = [
  { id: "tests.create", label: "Create tests", description: "Add new test cases." },
  { id: "tests.edit", label: "Edit tests", description: "Change steps and save test cases." },
  { id: "tests.delete", label: "Delete tests", description: "Remove test files from disk." },
  { id: "tests.run", label: "Run tests", description: "Execute a single test." },
  { id: "folders.manage", label: "Manage folders", description: "Create, delete, and move tests between folders." },
  { id: "suites.manage", label: "Manage suites", description: "Create and edit suites (ordered test chains)." },
  { id: "suites.run", label: "Run suites", description: "Execute a whole suite in one browser session." },
  { id: "reports.view", label: "View reports", description: "See the aggregate pass/fail reporting dashboard." },
  { id: "ai.analyze", label: "AI failure analysis", description: "Send failed steps to Anthropic's API for analysis (costs money per call)." },
  { id: "users.manage", label: "Manage users", description: "Add and remove accounts." }
];

export const FEATURE_IDS: string[] = FEATURES.map(f => f.id);

export const DEFAULT_FEATURES: Record<Role, string[]> = {
  site_admin: [...FEATURE_IDS],
  admin: [
    "tests.create", "tests.edit", "tests.delete", "tests.run",
    "folders.manage", "suites.manage", "suites.run",
    "reports.view", "ai.analyze", "users.manage"
  ],
  // Members can run things, build their own tests, and see reports. Destructive
  // or costly actions (delete, user admin, paid AI calls) stay opt-in per user.
  member: [
    "tests.create", "tests.edit", "tests.run",
    "folders.manage", "suites.run", "reports.view"
  ]
};

/** The features a user actually has: site admins get everything, everyone else gets their grants or role defaults. */
export function effectiveFeatures(role: Role, granted?: string[]): string[] {
  if (role === "site_admin") return [...FEATURE_IDS];
  const base = Array.isArray(granted) ? granted : DEFAULT_FEATURES[role];
  return base.filter(id => FEATURE_IDS.includes(id));
}

export function hasFeature(role: Role, granted: string[] | undefined, feature: string): boolean {
  return effectiveFeatures(role, granted).includes(feature);
}

export function normalizeRole(value: unknown): Role {
  return value === "site_admin" || value === "admin" ? value : "member";
}
