'use strict';

const DB_NAME = 'TindahanDB';
const DB_VERSION = 4; // Bumped to 4 for Ledger
let db = null;

function initDB() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('items')) {
        const s = d.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
        s.createIndex('category', 'category');
        s.createIndex('expiryDate', 'expiryDate');
        s.createIndex('sku', 'sku');
      }
      if (!d.objectStoreNames.contains('sales')) {
        const s = d.createObjectStore('sales', { keyPath: 'id', autoIncrement: true });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!d.objectStoreNames.contains('sales_archive')) {
        const s = d.createObjectStore('sales_archive', { keyPath: 'id', autoIncrement: true });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
      // NEW: Customers Store
      if (!d.objectStoreNames.contains('customers')) {
        const s = d.createObjectStore('customers', { keyPath: 'id', autoIncrement: true });
        s.createIndex('name', 'name');
      }
      // NEW: Ledger Transactions Store
      if (!d.objectStoreNames.contains('ledger')) {
        const s = d.createObjectStore('ledger', { keyPath: 'id', autoIncrement: true });
        s.createIndex('customerId', 'customerId');
        s.createIndex('createdAt', 'createdAt');
      }
    };

    req.onsuccess = () => {
      db = req.result;
      db.onversionchange = () => { db.close(); db = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other tabs of this app, then reload.'));
  });
}

function done(t, req) {
  return new Promise((resolve, reject) => {
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

// --- ITEMS & SALES (Existing) ---
async function getAllItems() { const t = db.transaction('items'); return done(t, t.objectStore('items').getAll()); }
async function getItem(id) { const t = db.transaction('items'); return done(t, t.objectStore('items').get(Number(id))); }
async function saveItem(item) { const t = db.transaction('items', 'readwrite'); const s = t.objectStore('items'); return done(t, item.id ? s.put(item) : s.add(item)); }
async function deleteItem(id) { const t = db.transaction('items', 'readwrite'); t.objectStore('items').delete(Number(id)); return done(t); }

async function completeSale(sale) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(['items', 'sales'], 'readwrite');
    const items = t.objectStore('items');
    const sales = t.objectStore('sales');
    let failure = null, saleId = null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const allReq = items.getAll();

    allReq.onsuccess = () => {
      const all = allReq.result;
      let costTotal = 0;
      for (const line of sale.items) {
        const item = all.find(i => i.id === line.itemId);
        if (!item) { failure = itemMissing(line.name); break; }
        if (item.stock < line.qty) { failure = 'Not enough stock for ' + line.name + ' (' + item.stock + ' left).'; break; }
        if (item.expiryDate && new Date(item.expiryDate + 'T00:00:00') < today) { failure = line.name + ' is expired. Remove it from the cart.'; break; }
        if (Math.round(item.price * 100) !== line.unitPrice) { failure = 'Price changed for ' + line.name + '. Review the cart and charge again.'; break; }
        line.unitCost = Math.round((item.cost || 0) * 100);
        line.lineTotal = line.unitPrice * line.qty;
        costTotal += line.unitCost * line.qty;
        item.stock -= line.qty;
        item.updatedAt = new Date().toISOString();
        items.put(item);
      }
      if (failure) { t.abort(); return; }
      sale.costTotal = costTotal;
      sale.profit = sale.total - costTotal;
      const add = sales.add(sale);
      add.onsuccess = () => { saleId = add.result; };
    };
    t.oncomplete = () => resolve(saleId);
    t.onabort = () => reject(new Error(failure || 'Sale cancelled. No stock was changed.'));
    t.onerror = () => reject(t.error || new Error('Could not save sale.'));
  });
}
function itemMissing(name) { return name + ' was deleted. Remove it from the cart.'; }
async function getAllSales() { const t = db.transaction('sales'); const all = await done(t, t.objectStore('sales').getAll()); return all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')); }
async function getSale(id) { const t = db.transaction('sales'); return done(t, t.objectStore('sales').get(Number(id))); }
async function replaceAllData(items, sales, customers = [], ledger = []) {
  const t = db.transaction(['items', 'sales', 'customers', 'ledger'], 'readwrite');
  const is = t.objectStore('items'), ss = t.objectStore('sales');
  const cs = t.objectStore('customers'), ls = t.objectStore('ledger');
  is.clear(); ss.clear(); cs.clear(); ls.clear();
  items.forEach(i => is.put(i));
  sales.forEach(s => ss.put(s));
  customers.forEach(c => cs.put(c));
  ledger.forEach(l => ls.put(l));
  return done(t);
}
function compressImage(file, maxWidth = 320) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) return resolve('');
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Unsupported image format'));
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
async function archiveOldSales(monthsToKeep = 12) {
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - monthsToKeep);
  const cutoffISO = cutoff.toISOString();
  const t = db.transaction(['sales', 'sales_archive'], 'readwrite');
  const sales = t.objectStore('sales'); const archive = t.objectStore('sales_archive');
  const allSales = await new Promise((resolve, reject) => { const req = sales.getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const toArchive = allSales.filter(s => s.createdAt < cutoffISO);
  if (toArchive.length === 0) return 0;
  toArchive.forEach(sale => { archive.put(sale); sales.delete(sale.id); });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(toArchive.length); t.onerror = () => reject(t.error); });
}
async function checkStorageUsage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return { usedMB: (estimate.usage / 1024 / 1024).toFixed(2), quotaMB: (estimate.quota / 1024 / 1024).toFixed(0), percentUsed: ((estimate.usage / estimate.quota) * 100).toFixed(1) };
}

// --- NEW: LEDGER HELPERS ---
async function getAllCustomers() {
  const t = db.transaction('customers');
  const customers = await done(t, t.objectStore('customers').getAll());
  return customers.sort((a, b) => a.name.localeCompare(b.name));
}

async function saveCustomer(customer) {
  const t = db.transaction('customers', 'readwrite');
  const s = t.objectStore('customers');
  return done(t, customer.id ? s.put(customer) : s.add(customer));
}

async function deleteCustomer(id) {
  // 1. First, find all ledger entries for this customer (readonly is safe and fast)
  const tRead = db.transaction('ledger', 'readonly');
  const allLedger = await new Promise((resolve, reject) => {
    const req = tRead.objectStore('ledger').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  
  const ledgerIdsToDelete = allLedger.filter(l => l.customerId === id).map(l => l.id);

  // 2. Open a SINGLE readwrite transaction for BOTH stores
  const tWrite = db.transaction(['customers', 'ledger'], 'readwrite');
  
  // Delete the customer
  tWrite.objectStore('customers').delete(Number(id));
  
  // Delete their associated ledger entries
  ledgerIdsToDelete.forEach(lId => {
    tWrite.objectStore('ledger').delete(lId);
  });

  // 3. Wait for the combined transaction to safely complete
  return new Promise((resolve, reject) => {
    tWrite.oncomplete = () => resolve();
    tWrite.onerror = () => reject(tWrite.error);
    tWrite.onabort = () => reject(tWrite.error || new Error('Transaction aborted'));
  });
}

async function getCustomerLedger(customerId) {
  const t = db.transaction('ledger');
  const all = await done(t, t.objectStore('ledger').getAll());
  return all.filter(l => l.customerId === customerId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function addLedgerEntry(entry) {
  const t = db.transaction('ledger', 'readwrite');
  return done(t, t.objectStore('ledger').add(entry));
}