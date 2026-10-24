/** Node carries the same managed controller and tenant service as the Worker. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { openDatabase, type NodeDatabase } from '../db/database.js';
import { createManagedApi, type ManagedApi } from './api.js';
import { ManagedStore } from './store.js';
import { ManagedTenant } from './tenant.js';

export function createNodeManaged(config: Config): { api: ManagedApi; close(): void } | null {
  const managed = config.managedHosting;
  if (managed === undefined || managed === null) return null;
  const dir = join(config.dataDir, 'managed');
  mkdirSync(dir, { recursive: true });
  const registry = openDatabase(join(dir, 'directory.sqlite'));
  const tenants = new Map<string, { db: NodeDatabase; tenant: ManagedTenant }>();
  const tenant = (id: string): ManagedTenant => {
    // Only registry-issued ids reach the transport. Keep the filesystem boundary explicit.
    if (!/^c_[A-Za-z0-9_-]{12}$/.test(id)) throw new Error('invalid tenant id');
    let value = tenants.get(id);
    if (value === undefined) {
      const db = openDatabase(join(dir, `${id}.sqlite`));
      value = { db, tenant: new ManagedTenant(db.driver, { ...config, secret: managed.secret }) };
      tenants.set(id, value);
    }
    return value.tenant;
  };
  const api = createManagedApi({
    store: new ManagedStore(registry.driver),
    config: managed,
    transport: {
      initialize: async (input) => tenant(input.club.id).initialize(input),
      connect: async (id, credential) => tenant(id).connect(credential),
      describe: async (id) => tenant(id).describe(),
      rekeyOwner: async (id, credential) => tenant(id).rekeyOwner(credential),
      authorizeOwner: async (id, token, credential) => tenant(id).authorizeOwner(token, credential),
      request: (id, request, credential) => tenant(id).handle(request, credential),
    },
  });
  return {
    api,
    close() {
      for (const entry of tenants.values()) entry.db.close();
      tenants.clear();
      registry.close();
    },
  };
}
