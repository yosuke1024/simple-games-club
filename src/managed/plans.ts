/** Contract capacities, not prices. Plus and MAX remain future definitions. */
export const MANAGED_PLANS = [
  { id: 'trial', maxMembersPerClub: 5, maxClubs: 1, available: true },
  { id: 'basic', maxMembersPerClub: 50, maxClubs: 3, available: true },
  { id: 'plus', maxMembersPerClub: 100, maxClubs: 5, available: false },
  { id: 'max', maxMembersPerClub: null, maxClubs: 100, available: false },
] as const;

export const TRIAL_PLAN = MANAGED_PLANS[0];
export const BASIC_PLAN = MANAGED_PLANS[1];
export type ManagedPlanId = 'trial' | 'basic';
export const planOf = (plan: ManagedPlanId) => (plan === 'trial' ? TRIAL_PLAN : BASIC_PLAN);
export const AD_REMOVAL_MEMBERS = 50;
export const MANAGED_PREFIX = '/api/v1/managed';
export const MANAGED_CLUB_PATH = /^\/clubs\/(c_[A-Za-z0-9_-]{12})(\/api\/.*)$/;

export const isManagedPath = (path: string): boolean =>
  path === MANAGED_PREFIX || path.startsWith(`${MANAGED_PREFIX}/`) || path.startsWith('/clubs/');
