// Shared by the server and the browser bundles: the role/scope model and the RPC method table.
export type Role = 'admin' | 'user' | 'viewer';

/** Role to scope map (server-side source of truth; the browser only uses it for early refusals and the proof checklist). */
export const ROLE_SCOPES: Record<Role, string[]> = {
  admin: ['vehicles.read', 'notes.read', 'notes.write', 'admin.children'],
  user: ['vehicles.read', 'notes.read', 'notes.write'],
  viewer: ['vehicles.read', 'notes.read'],
};

/** Scopes an admin may grant to a child frame. */
export const ASSIGNABLE_SCOPES = ['vehicles.read', 'notes.read', 'notes.write'] as const;

/** Scope each RPC method needs (null = none). */
export const METHOD_SCOPE: Record<string, string | null> = {
  whoami: null,
  'vehicles.list': 'vehicles.read',
  'notes.list': 'notes.read',
  'notes.add': 'notes.write',
  multi: null,
};

export function intersect(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((x) => b.includes(x));
}

export function effectiveScopes(childScopes: readonly string[], role: Role): string[] {
  return intersect(childScopes, ROLE_SCOPES[role]);
}

// ---- Platform (mainframe) permissions: what a role may do in the mainframe's OWN screens (not the child-frame API) ----
export const PLATFORM_PERMS: Record<Role, string[]> = {
  admin: ['users.manage', 'groups.manage', 'access.manage', 'apps.install', 'apps.register', 'reports.read'],
  user: ['reports.read'],
  viewer: [],
};

export const PLATFORM_PERM_LABELS: Record<string, string> = {
  'users.manage': 'Create, change and disable users',
  'groups.manage': 'Create groups and manage their members',
  'access.manage': 'Choose which groups may open each installed app',
  'apps.install': 'Install and uninstall apps from the App Store',
  'apps.register': 'Register new apps (upload HTML, add links)',
  'reports.read': 'View usage reports',
};

export const SCOPE_LABELS: Record<string, string> = {
  'vehicles.read': 'Read the tenant vehicles',
  'notes.read': 'Read the tenant notes',
  'notes.write': 'Add notes on behalf of the user',
  'admin.children': 'Manage child frames',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Runs the tenant: manages users, groups, access and apps, and sees reports.',
  user: 'Works in the installed apps (read and write) and sees reports.',
  viewer: 'Read-only access to installed apps. No reports, no administration.',
};
