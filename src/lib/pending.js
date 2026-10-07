"use strict";

(function () {
  const DB_NAME = "synthid-check";
  const STORE = "pending";
  const TTL_MS = 10 * 60 * 1000;

  let dbPromise = null;

  function req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    });
  }

  function open() {
    if (!dbPromise) {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: "tabId" });
      };
      dbPromise = req(request).catch((e) => {
        dbPromise = null;
        throw e;
      });
    }
    return dbPromise;
  }

  async function withStore(mode, fn) {
    const db = await open();
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    await done(tx);
    return result;
  }

  function isExpired(record, now = Date.now()) {
    return !record || typeof record.createdAt !== "number" || now - record.createdAt > TTL_MS;
  }

  function put(record) {
    const full = {
      createdAt: Date.now(),
      autoAttach: true,
      attachedAt: null,
      signInSeen: false,
      ...record,
    };
    return withStore("readwrite", (store) => {
      store.put(full);
    });
  }

  async function get(tabId) {
    const value = await withStore("readonly", (store) => req(store.get(tabId)));
    if (!value) return null;
    if (isExpired(value)) {
      await remove(tabId);
      return null;
    }
    return value;
  }

  async function update(tabId, patch) {
    let updated = null;
    await withStore("readwrite", (store) => {
      const getReq = store.get(tabId);
      getReq.onsuccess = () => {
        if (!getReq.result) return;
        updated = { ...getReq.result, ...patch, tabId };
        store.put(updated);
      };
    });
    return updated;
  }

  function remove(tabId) {
    return withStore("readwrite", (store) => {
      store.delete(tabId);
    });
  }

  function purgeExpired() {
    const now = Date.now();
    return withStore("readwrite", (store) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        if (isExpired(cursor.value, now)) cursor.delete();
        cursor.continue();
      };
    });
  }

  globalThis.SynthIDPending = { TTL_MS, put, get, update, remove, purgeExpired };
})();
