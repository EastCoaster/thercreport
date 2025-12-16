// IndexedDB Wrapper for RC Race Program
const DB_NAME = 'rc_program';
const DB_VERSION = 1.1;

let dbInstance = null;

// Utility: get all store names (helps when schema changes often during development)
function getStoreNames(db) {
  return Array.from(db.objectStoreNames || []);
}

/**
 * Initialize the database and create object stores
 * @returns {Promise<IDBDatabase>}
 */
export async function dbInit() {
  if (dbInstance) {
    return dbInstance;
  }

  let retryCount = 0;
  const maxRetries = 5;
  const retryDelay = 500;

  function openDb(resolve, reject) {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      const error = event.target.error;
      if (error && error.name === 'InvalidStateError' && retryCount < maxRetries) {
        // Version change transaction in progress, retry after delay
        retryCount++;
        console.warn(`[DB] Version change in progress, retrying open (${retryCount}/${maxRetries})...`);
        setTimeout(() => openDb(resolve, reject), retryDelay);
        return;
      }
      const err = new Error('Failed to open IndexedDB database');
      console.error('❌ [DB]', err);
      reject(err);
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      console.log('✅ [DB] Database opened successfully');

      // Data migrations after schema upgrade
      // Upgrade logic for cars: add transponder if missing
      const carTx = dbInstance.transaction(['cars'], 'readwrite');
      const carStore = carTx.objectStore('cars');
      carStore.openCursor().onsuccess = function (event) {
        const cursor = event.target.result;
        if (cursor) {
          const car = cursor.value;
          if (!('transponder' in car)) car.transponder = '';
          cursor.update(car);
          cursor.continue();
        }
      };

      // Upgrade tracks: remove lat/lng, add websiteUrl if missing
      const trackTx = dbInstance.transaction(['tracks'], 'readwrite');
      const trackStore = trackTx.objectStore('tracks');
      trackStore.openCursor().onsuccess = function (event) {
        const cursor = event.target.result;
        if (cursor) {
          const track = cursor.value;
          if ('lat' in track) delete track.lat;
          if ('lng' in track) delete track.lng;
          if (!('websiteUrl' in track)) track.websiteUrl = '';
          cursor.update(track);
          cursor.continue();
        }
      };

      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      console.log('🔧 [DB] Upgrading database schema...');

      // Create 'cars' object store
      if (!db.objectStoreNames.contains('cars')) {
        db.createObjectStore('cars', { keyPath: 'id' });
        console.log('  ✓ Created "cars" store');
      }

      // Create 'setups' object store with indexes
      if (!db.objectStoreNames.contains('setups')) {
        const setupsStore = db.createObjectStore('setups', { keyPath: 'id' });
        setupsStore.createIndex('carId', 'carId', { unique: false });
        setupsStore.createIndex('trackId', 'trackId', { unique: false });
        setupsStore.createIndex('createdAt', 'createdAt', { unique: false });
        console.log('  ✓ Created "setups" store with indexes');
      }

      // Create 'tracks' object store
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id' });
        console.log('  ✓ Created "tracks" store');
      }

      // Create 'events' object store with index
      if (!db.objectStoreNames.contains('events')) {
        const eventsStore = db.createObjectStore('events', { keyPath: 'id' });
        eventsStore.createIndex('date', 'date', { unique: false });
        console.log('  ✓ Created "events" store with index');
      }

      // Create 'runLogs' object store with indexes
      if (!db.objectStoreNames.contains('runLogs')) {
        const runLogsStore = db.createObjectStore('runLogs', { keyPath: 'id' });
        runLogsStore.createIndex('eventId', 'eventId', { unique: false });
        runLogsStore.createIndex('carId', 'carId', { unique: false });
        runLogsStore.createIndex('createdAt', 'createdAt', { unique: false });
        console.log('  ✓ Created "runLogs" store with indexes');
      }

      console.log('✅ [DB] Database schema upgraded');
    };
  }

  return new Promise(openDb);
}

/**
 * Add a new item to a store (fails if item with same key exists)
 * @param {string} store - Store name
 * @param {object} item - Item to add
 * @returns {Promise<any>} The key of the added item
 */
export async function add(store, item) {
  try {
    const db = await dbInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([store], 'readwrite');
      const objectStore = transaction.objectStore(store);
      const request = objectStore.add(item);

      request.onsuccess = () => {
        console.log(`✅ [DB] Added to ${store}:`, request.result);
        resolve(request.result);
      };

      request.onerror = () => {
        const error = new Error(`Failed to add item to ${store}: ${request.error}`);
        console.error('❌ [DB]', error);
        reject(error);
      };
    });
  } catch (error) {
    console.error('❌ [DB] Add error:', error);
    throw error;
  }
}

/**
 * Put (add or update) an item in a store
 * @param {string} store - Store name
 * @param {object} item - Item to put
 * @returns {Promise<any>} The key of the item
 */
export async function put(store, item) {
  try {
    const db = await dbInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([store], 'readwrite');
      const objectStore = transaction.objectStore(store);
      const request = objectStore.put(item);

      request.onsuccess = () => {
        console.log(`✅ [DB] Put to ${store}:`, request.result);
        resolve(request.result);
      };

      request.onerror = () => {
        const error = new Error(`Failed to put item to ${store}: ${request.error}`);
        console.error('❌ [DB]', error);
        reject(error);
      };
    });
  } catch (error) {
    console.error('❌ [DB] Put error:', error);
    throw error;
  }
}

/**
 * Get an item from a store by ID
 * @param {string} store - Store name
 * @param {any} id - Item ID
 * @returns {Promise<any>} The item or undefined if not found
 */
export async function get(store, id) {
  try {
    const db = await dbInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([store], 'readonly');
      const objectStore = transaction.objectStore(store);
      const request = objectStore.get(id);

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        const error = new Error(`Failed to get item from ${store}: ${request.error}`);
        console.error('❌ [DB]', error);
        reject(error);
      };
    });
  } catch (error) {
    console.error('❌ [DB] Get error:', error);
    throw error;
  }
}

/**
 * Get all items from a store
 * @param {string} store - Store name
 * @returns {Promise<Array>} Array of all items in the store
 */
export async function getAll(store) {
  try {
    const db = await dbInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([store], 'readonly');
      const objectStore = transaction.objectStore(store);
      const request = objectStore.getAll();

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        const error = new Error(`Failed to get all items from ${store}: ${request.error}`);
        console.error('❌ [DB]', error);
        reject(error);
      };
    });
  } catch (error) {
    console.error('❌ [DB] GetAll error:', error);
    throw error;
  }
}

/**
 * Remove an item from a store by ID
 * @param {string} store - Store name
 * @param {any} id - Item ID to remove
 * @returns {Promise<void>}
 */
export async function remove(store, id) {
  try {
    const db = await dbInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([store], 'readwrite');
      const objectStore = transaction.objectStore(store);
      const request = objectStore.delete(id);

      request.onsuccess = () => {
        console.log(`✅ [DB] Removed from ${store}:`, id);
        resolve();
      };

      request.onerror = () => {
        const error = new Error(`Failed to remove item from ${store}: ${request.error}`);
        console.error('❌ [DB]', error);
        reject(error);
      };
    });
  } catch (error) {
    console.error('❌ [DB] Remove error:', error);
    throw error;
  }
}

// Normalize setupData to schema v2 shape without mutating stored record
export function normalizeSetupData(setup = {}) {
  const data = setup.setupData || {};
  const schema = setup.setupSchemaVersion || 1;

  const chassis = data.chassis || {};
  const suspension = data.suspension || {};
  const drivetrain = data.drivetrain || {};
  const tires = data.tires || {};
  const electronics = data.electronics || {};
  const general = data.general || {};

  const norm = {
    chassis: {
      rideHeightF: chassis.rideHeightF || '',
      rideHeightR: chassis.rideHeightR || '',
      droopF: chassis.droopF || '',
      droopR: chassis.droopR || '',
      weightBalanceNotes: chassis.weightBalanceNotes || ''
    },
    suspension: {
      springsF: suspension.springsF || '',
      springsR: suspension.springsR || '',
      pistonsF: suspension.pistonsF || '',
      pistonsR: suspension.pistonsR || '',
      shockOilF: suspension.shockOilF || '',
      shockOilR: suspension.shockOilR || '',
      shockPosF: suspension.shockPosF || '',
      shockPosR: suspension.shockPosR || '',
      camberF: suspension.camberF || '',
      camberR: suspension.camberR || '',
      toeF: suspension.toeF || '',
      toeR: suspension.toeR || ''
    },
    drivetrain: {
      pinion: drivetrain.pinion || '',
      spur: drivetrain.spur || '',
      fdrNotes: drivetrain.fdrNotes || '',
      diffType: drivetrain.diffType || '',
      diffOilF: drivetrain.diffOilF || '',
      diffOilR: drivetrain.diffOilR || '',
      centerDiffOil: drivetrain.centerDiffOil || ''
    },
    tires: {
      tireBrand: tires.tireBrand || '',
      tireCompound: tires.tireCompound || '',
      insert: tires.insert || '',
      sauce: tires.sauce || '',
      prepNotes: tires.prepNotes || ''
    },
    electronics: {
      escProfile: electronics.escProfile || '',
      timing: electronics.timing || '',
      punch: electronics.punch || '',
      motorNotes: electronics.motorNotes || ''
    },
    general: {
      trackCondition: general.trackCondition || '',
      temp: general.temp || '',
      notes: general.notes || ''
    }
  };

  // Backward compatibility: map legacy flat fields into v2
  if (schema < 2) {
    if (data.rideHeight && !norm.chassis.rideHeightF) norm.chassis.rideHeightF = data.rideHeight;
    if (data.springs && !norm.suspension.springsF) norm.suspension.springsF = data.springs;
    if (data.shockOil && !norm.suspension.shockOilF) norm.suspension.shockOilF = data.shockOil;
  }

  return norm;
}

/**
 * Query items by index (exact match)
 * @param {string} store - Store name
 * @param {string} indexName - Index name
 * @param {any} value - Value to match
 * @returns {Promise<Array>} Array of matching items
 */
export async function queryIndex(store, indexName, value) {
  try {
    const db = await dbInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([store], 'readonly');
      const objectStore = transaction.objectStore(store);
      
      // Check if index exists
      if (!objectStore.indexNames.contains(indexName)) {
        const error = new Error(`Index "${indexName}" does not exist on store "${store}"`);
        console.error('❌ [DB]', error);
        reject(error);
        return;
      }
      
      const index = objectStore.index(indexName);
      const request = index.getAll(value);

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        const error = new Error(`Failed to query ${store} by ${indexName}: ${request.error}`);
        console.error('❌ [DB]', error);
        reject(error);
      };
    });
  } catch (error) {
    console.error('❌ [DB] QueryIndex error:', error);
    throw error;
  }
}

/**
 * Clear all object stores in the current database (development helper)
 * Leaves the database and version intact but removes all records.
 */
export async function clearAllStores() {
  const db = await dbInit();
  const storeNames = getStoreNames(db);

  if (!storeNames.length) {
    console.warn('[DB] No stores to clear');
    return;
  }

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeNames, 'readwrite');

      tx.oncomplete = () => {
        console.log('[DB] Cleared all stores');
        resolve();
      };

      tx.onerror = () => {
        const error = new Error(`Failed to clear stores: ${tx.error}`);
        console.error('❌ [DB]', error);
        reject(error);
      };

      storeNames.forEach((name) => {
        try {
          tx.objectStore(name).clear();
        } catch (err) {
          console.warn(`[DB] Could not clear store ${name}:`, err);
        }
      });
    } catch (error) {
      console.error('❌ [DB] Transaction failed while clearing stores:', error);
      reject(error);
    }
  });
}

/**
 * Delete the entire database (development helper).
 * This will drop all stores; call dbInit afterward to recreate.
 */
export async function resetDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }

  return new Promise((resolve, reject) => {
    const deleteRequest = indexedDB.deleteDatabase(DB_NAME);

    deleteRequest.onsuccess = () => {
      console.log('[DB] Database deleted');
      resolve();
    };

    deleteRequest.onerror = () => {
      const error = new Error(`Failed to delete database: ${deleteRequest.error}`);
      console.error('❌ [DB]', error);
      reject(error);
    };

    deleteRequest.onblocked = () => {
      console.warn('[DB] Delete blocked; close other tabs or reload.');
    };
  });
}

/**
 * Generate a unique ID with optional prefix
 * @param {string} prefix - Optional prefix for the ID
 * @returns {string} Generated unique ID
 */
export function generateId(prefix = '') {
  let id;
  
  // Use crypto.randomUUID if available (modern browsers)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    id = crypto.randomUUID();
  } else {
    // Fallback: timestamp + random string
    const timestamp = Date.now().toString(36);
    const randomStr = Math.random().toString(36).substring(2, 15);
    id = `${timestamp}-${randomStr}`;
  }
  
  return prefix ? `${prefix}_${id}` : id;
}
