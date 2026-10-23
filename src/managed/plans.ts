/** Contract capacities, not prices. Only Basic may currently be provisioned. */
export const MANAGED_PLANS = [
  { id: 'basic', maxMembersPerClub: 50, maxClubs: 3, available: true },
  { id: 'plus', maxMembersPerClub: 100, maxClubs: 5, available: false },
  { id: 'max', maxMembersPerClub: null, maxClubs: 100, available: false },
] as const;

export const BASIC_PLAN = MANAGED_PLANS[0];
export const MANAGED_PREFIX = '/api/v1/managed';
export const MANAGED_CLUB_PATH = /^\/clubs\/(c_[A-Za-z0-9_-]{12})(\/api\/.*)$/;

export const isManagedPath = (path: string): boolean =>
  path === MANAGED_PREFIX || path.startsWith(`${MANAGED_PREFIX}/`) || path.startsWith('/clubs/');
