interface IQueryById {
  /** id of Entity to get */
  id: string;
}

/**
 * A simple interface for a 'table' of data.
 * Meant to be able to be shared across in-memory implementations and @pulumi/cloud.Table.
 * As much as possible, it tries to be a subset of @pulumi/cloud.Table
 */
export interface ISimpleTable<Entity> {
  /** delete a single entity by id */
  delete(query: IQueryById): Promise<void>;
  /** Get a single entity by id */
  get(query: IQueryById): Promise<Entity>;
  /** Add a new entity */
  insert(e: Entity): Promise<void>;
  /** Get all entities */
  scan(): Promise<Entity[]>;
  /** Scan through batches of entities, passing them to callback */
  scan(callback: (items: Entity[]) => Promise<boolean>): Promise<void>;
  /**
   * Updates a documents in the table.
   * If no item matches query exists, a new one should be created.
   *
   * @param query An object with the primary key ("id" by default) assigned
   * the value to lookup.
   * @param updates An object with all document properties that should be
   * updated.
   * @returns A promise for the success or failure of the update.
   */
  update(query: IQueryById, updates: Partial<Entity>): Promise<void>;
}

interface IHasId {
  /** id of object */
  id: string;
}

/** Implementation of ISimpleTable that stores data in-memory in a Map */
export const MapSimpleTable = <Entity extends IHasId>(
  map = new Map<string, Entity>(),
): ISimpleTable<Entity> => {
  type ScanCallback = (entities: Entity[]) => Promise<boolean>;
  // tslint:disable:completed-docs
  async function scan(): Promise<Entity[]>;
  async function scan(callback: ScanCallback): Promise<undefined>;
  async function scan(callback?: ScanCallback) {
    if (callback) {
      for (const e of map.values()) {
        await callback([e]);
      }
      return;
    } else {
      const values = Array.from(map.values());
      return values;
    }
  }
  // tslint:enable:completed-docs
  return {
    async delete(query: IQueryById) {
      map.delete(query.id);
    },
    async get(query: IQueryById) {
      const got = map.get(query.id);
      if (!got) {
        throw new Error(`Entity not found for id=${query.id}`);
      }
      return got;
    },
    async insert(entity: Entity) {
      map.set(entity.id, entity);
    },
    scan,
    async update(query: IQueryById, updates) {
      const got = map.get(query.id) || {};
      const updated = { ...query, ...got, ...updates };
      // Type assertion is bad but required to emulated untyped nature of the pulumi/cloud aws table implementation
      map.set(query.id, updated as Entity);
    },
  };
};

/** Return items in an ISimpleTable that match the provided filter function */
export const filterTable = async <ItemType extends object>(
  table: ISimpleTable<ItemType>,
  itemFilter: (item: ItemType) => boolean,
): Promise<ItemType[]> => {
  const filteredItems: ItemType[] = [];
  await table.scan(async items => {
    filteredItems.push(...items.filter(itemFilter));
    return true;
  });
  return filteredItems;
};
