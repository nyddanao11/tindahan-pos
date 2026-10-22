'use strict';

const $ = s => document.querySelector(s);
const app = $('#app-content');

// Money is always calculated in CENTAVOS (integers) to avoid 0.1 + 0.2 bugs
const toCents = n => Math.round((Number(n) || 0) * 100);
const money = c => '₱' + ((Number(c) || 0) / 100).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CATS = ['Snacks', 'Drinks', 'Noodles', 'Canned Goods', 'Rice & Corn',
              'Personal Care', 'Cleaning', 'Cigarettes', 'Other'];

const state = {
  view: 'dashboard', items: [], cart: [], discount: '',
  editingId: null, showForm: false, formImage: '',
  search: '', category: 'All', invSearch: '', invCategory: 'All', saving: false
};

function daysLeft(date) {
  if (!date) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(date + 'T00:00:00') - today) / 86400000);
}

function persistCart() {
  try { localStorage.setItem('tindahan_cart', JSON.stringify(state.cart)); } catch (e) {}
}
function restoreCart() {
  try {
    const raw = JSON.parse(localStorage.getItem('tindahan_cart') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) { return []; }
}

function toast(msg, type = 'info') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

function modal(html) {
  let d = $('#app-modal');
  if (!d) { d = document.createElement('dialog'); d.id = 'app-modal'; document.body.appendChild(d); }
  d.innerHTML = html;
  if (!d.open) d.showModal();
  d.onclick = e => { if (e.target === d) d.close(); };
  return d;
}
function closeModal() { const d = $('#app-modal'); if (d && d.open) d.close(); }

function safeImg(item) {
  return item.image && item.image.startsWith('data:image/') ? item.image : '';
}
function thumb(item, size = 60) {
  const src = safeImg(item);
  return src
    ? `<img class="thumb" style="width:${size}px;height:${size}px" src="${src}" alt="">`
    : `<span class="thumb fallback" style="width:${size}px;height:${size}px">${esc((item.name || '?').charAt(0).toUpperCase())}</span>`;
}

/* ---------------- BOOT ---------------- */

document.addEventListener('DOMContentLoaded', async () => {
  try { await initDB(); }
  catch (err) {
    app.innerHTML = `<div class="card"><h2>Storage unavailable</h2>
      <p>${esc(err.message)}</p><p>Exit private/incognito mode, allow site data, then reload.</p></div>`;
    return;
  }

  setupNav();
  updateStatus(navigator.onLine);
  renderDashboard();

  window.addEventListener('online', () => updateStatus(true));
  window.addEventListener('offline', () => { updateStatus(false); toast('Offline mode — you can still sell.'); });

  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});

function updateStatus(online) {
  const dot = $('#sync-status');
  if (dot) {
    dot.className = 'status-dot ' + (online ? 'online' : 'offline');
    dot.title = online ? 'Online — data is stored on this device' : 'Offline — all features work';
  }
}

function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
      state.view = btn.dataset.view;
      if (state.view === 'dashboard') renderDashboard();
      if (state.view === 'pos') renderPOS();
      if (state.view === 'inventory') renderInventory();
    };
  });
}

/* ---------------- ONE GLOBAL CLICK HANDLER ---------------- */

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b || b.disabled) return;
  const a = b.dataset.action;
  const id = b.dataset.id ? Number(b.dataset.id) : null;

  switch (a) {
    case 'new-item':
      state.editingId = null; state.showForm = true; state.formImage = '';
      await renderInventory();
      $('#item-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#f-name').focus();
      break;

    case 'edit-item': await startEdit(id); break;
    case 'delete-item': await removeItem(id); break;

    case 'cancel-edit':
      state.editingId = null; state.showForm = false; state.formImage = '';
      await renderInventory();
      break;

    case 'category':
      state.category = b.dataset.value; renderPOSCatalog(); break;

    case 'add-cart': await addToCart(id); break;
    case 'qty': await changeQty(id, Number(b.dataset.delta)); break;

    case 'remove-cart':
      state.cart = state.cart.filter(l => l.itemId !== id);
      persistCart(); renderCart(); renderPOSCatalog(); break;

    case 'clear-cart':
      if (state.cart.length && confirm('Clear this cart?')) {
        state.cart = []; state.discount = '';
        persistCart(); renderCart(); renderPOSCatalog();
      }
      break;

    case 'checkout': openCheckout(); break;

    case 'cash':
      if ($('#cash-received')) {
        $('#cash-received').value = b.dataset.value === 'exact'
          ? (cartTotals().total / 100).toFixed(2) : b.dataset.value;
        updateChangeUI();
      }
      break;

    case 'complete-sale': await finishSale(); break;
    case 'close-modal': closeModal(); break;
    case 'print': window.print(); break;
    case 'view-sale': await showReceipt(id); break;
    case 'export': await exportBackup(); break;
    case 'import': if ($('#import-file')) $('#import-file').click(); break;
  }
});

/* ---------------- DASHBOARD ---------------- */

async function renderDashboard() {
  const [items, sales] = await Promise.all([getAllItems(), getAllSales()]);
  state.items = items;

  const todayKey = new Date().toDateString();
  const todaySales = sales.filter(s => new Date(s.createdAt).toDateString() === todayKey);
  const revenue = todaySales.reduce((sum, s) => sum + s.total, 0);
  const profit = todaySales.reduce((sum, s) => sum + (s.profit || 0), 0);
  const stockValue = items.reduce((sum, i) => sum + toCents(i.cost) * (Number(i.stock) || 0), 0);

  const low = items.filter(i => (Number(i.stock) || 0) <= (i.reorderLevel ?? 5));
  const expired = items.filter(i => { const d = daysLeft(i.expiryDate); return d !== null && d < 0; });
  const expiring = items.filter(i => { const d = daysLeft(i.expiryDate); return d !== null && d >= 0 && d <= 7; });
  const missingCost = items.filter(i => !Number(i.cost)).length;

  app.innerHTML = `
    <h2>Store Overview</h2>
    <p class="muted">${new Date().toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' })}</p>

    <div class="stats-grid">
      <div class="stat"><small>Today's sales</small><strong>${money(revenue)}</strong></div>
      <div class="stat green"><small>Today's profit</small><strong>${money(profit)}</strong></div>
      <div class="stat"><small>Items tracked</small><strong>${items.length}</strong></div>
      <div class="stat"><small>Stock value (cost)</small><strong>${money(stockValue)}</strong></div>
    </div>

    <div class="card attention">
      <h3>⚠️ Protect your profit</h3>
      ${expired.length ? `<p class="danger-text">● ${expired.length} EXPIRED — remove from shelf now.</p>` : ''}
      ${expiring.length ? `<p class="warn-text">● ${expiring.length} expiring within 7 days — discount or bundle these.</p>` : ''}
      ${low.length ? `<p class="warn-text">● ${low.length} items at or below reorder level — restock.</p>` : ''}
      ${missingCost ? `<p class="muted">● ${missingCost} items have no cost entered. Profit is incomplete.</p>` : ''}
      ${!expired.length && !expiring.length && !low.length ? '<p class="success-text">✓ Stock looks healthy.</p>' : ''}
    </div>

    ${expiring.length ? `
      <div class="card">
        <h3>Expiring soon — act today</h3>
        ${expiring.slice(0, 6).map(i => miniRow(i, `Expires ${esc(i.expiryDate)} · ${i.stock} left`)).join('')}
      </div>` : ''}

    ${low.length ? `
      <div class="card">
        <h3>Low stock</h3>
        ${low.slice(0, 6).map(i => miniRow(i, `${i.stock} left · reorder at ${i.reorderLevel ?? 5}`)).join('')}
      </div>` : ''}

    <div class="card">
      <h3>Recent sales</h3>
      ${sales.length ? sales.slice(0, 5).map(s => `
        <button class="sale-row" data-action="view-sale" data-id="${s.id}">
          <span><strong>${money(s.total)}</strong><small>${esc(s.receiptNo)}</small></span>
          <span class="muted">${new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ›</span>
        </button>`).join('') : '<p class="muted">No sales yet. Open POS to make your first sale.</p>'}
    </div>

    <div class="card">
      <h3>Backup your store</h3>
      <p class="muted">Your inventory and receipts live in THIS browser on THIS device.
      Clearing browser data deletes them. Export a backup weekly.</p>
      <div class="btn-row">
        <button class="btn-primary small" data-action="export">Export backup</button>
        <button class="btn-small" data-action="import">Import backup</button>
      </div>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
    </div>`;

  $('#import-file').onchange = async (e) => {
    if (e.target.files[0]) await importBackup(e.target.files[0]);
    e.target.value = '';
  };
}

function miniRow(item, note) {
  return `<div class="mini-row">${thumb(item, 36)}
    <div class="mini-info"><strong>${esc(item.name)}</strong><small>${esc(note)}</small></div>
    <button class="btn-small" data-action="edit-item" data-id="${item.id}">Edit</button>
  </div>`;
}

/* ---------------- INVENTORY ---------------- */

async function renderInventory() {
  const items = await getAllItems();
  state.items = items;

  const cats = [...new Set([...CATS, ...items.map(i => i.category).filter(Boolean)])];

  app.innerHTML = `
    <div class="row-between"><h2>Inventory</h2>
      <button class="btn-primary small" data-action="new-item">＋ Add item</button>
    </div>

    <div class="toolbar">
      <input id="inv-search" placeholder="Search name or SKU..." value="${esc(state.invSearch)}">
      <select id="inv-category">
        <option value="All">All categories</option>
        ${cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
      </select>
    </div>

    <form id="item-form" class="card form-card" ${state.showForm ? '' : 'hidden'}>
      <div class="row-between"><h3 id="form-title">${state.editingId ? 'Edit item' : 'New item'}</h3>
        <button type="button" class="link" data-action="cancel-edit">Cancel</button>
      </div>

      <div class="form-grid">
        <label>Item name *<input id="f-name" required maxlength="80" placeholder="e.g. Piattos Barbecue"></label>
        <label>SKU / Barcode<input id="f-sku" maxlength="40" placeholder="Optional"></label>
        <label>Category<input id="f-category" list="category-list" placeholder="Snacks">
          <datalist id="category-list">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        </label>
        <label>Selling unit
          <select id="f-unit">${['pcs', 'pack', 'box', 'kg', 'liter', 'can'].map(u => `<option>${u}</option>`).join('')}</select>
        </label>
        <label>Price (sell) *<input id="f-price" type="number" min="0" step="0.01" required placeholder="15.00"></label>
        <label>Cost (you pay)<input id="f-cost" type="number" min="0" step="0.01" placeholder="12.00">
          <small class="muted">Per ${'selling unit'} — not per case.</small>
        </label>
        <label>Stock on hand<input id="f-stock" type="number" min="0" step="1" value="0"></label>
        <label>Low-stock alert at<input id="f-reorder" type="number" min="0" step="1" value="5"></label>
        <label>Expiry date<input id="f-expiry" type="date"></label>
        <label>Supplier<input id="f-supplier" maxlength="60" placeholder="e.g. Candy shop / supplier"></label>
      </div>

      <label>Photo<input id="f-image" type="file" accept="image/*"></label>
      <img id="form-image-preview" class="preview" alt="Item preview" style="display:none">
      <label>Notes<textarea id="f-notes" rows="2" placeholder="Shelf location, terms, bundle ideas..."></textarea></label>

      <button type="submit" class="btn-primary" id="save-label">${state.editingId ? 'Update item' : 'Save item'}</button>
    </form>

    <div id="inv-list"></div>`;

  $('#inv-category').value = state.invCategory;
  $('#inv-search').oninput = e => { state.invSearch = e.target.value; renderInventoryList(); };
  $('#inv-category').onchange = e => { state.invCategory = e.target.value; renderInventoryList(); };
  $('#f-image').onchange = handleImageUpload;

  $('#item-form').onsubmit = async (e) => {
    e.preventDefault();
    await saveItemFromForm();
  };

  if (state.editingId) await fillEditForm(state.editingId);
  renderInventoryList();
}

async function renderInventoryList() {
  const q = state.invSearch.trim().toLowerCase();
  const list = state.items.filter(i =>
    (state.invCategory === 'All' || i.category === state.invCategory) &&
    (!q || (i.name + ' ' + (i.sku || '')).toLowerCase().includes(q))
  );

  $('#inv-list').innerHTML = list.length ? list.map(i => {
    const margin = toCents(i.cost) > 0 && toCents(i.price) > 0
      ? Math.round((toCents(i.price) - toCents(i.cost)) / toCents(i.price) * 100) + '% margin'
      : 'set cost';
    const dl = daysLeft(i.expiryDate);

    return `<div class="card item-row">
      ${thumb(i, 48)}
      <div class="item-info">
        <strong>${esc(i.name)}</strong>
        <small class="muted">${esc(i.category || 'Other')} · ${esc(i.unit || 'pcs')}${i.sku ? ' · ' + esc(i.sku) : ''}</small>
        <div class="price-line"><b>${money(toCents(i.price))}</b><span class="muted">cost ${money(toCents(i.cost))}</span><span class="muted">${margin}</span></div>
        <div class="badges">
          ${Number(i.stock) <= 0 ? '<span class="badge red">Out of stock</span>'
            : Number(i.stock) <= (i.reorderLevel ?? 5) ? `<span class="badge orange">${i.stock} left · low</span>`
            : `<span class="badge green">${i.stock} in stock</span>`}
          ${dl !== null && dl < 0 ? '<span class="badge red">EXPIRED</span>'
            : dl !== null && dl <= 7 ? `<span class="badge orange">${dl === 0 ? 'Expires today' : 'Expires in ' + dl + 'd'}</span>` : ''}
        </div>
      </div>
      <div class="row-actions">
        <button class="btn-small" data-action="edit-item" data-id="${i.id}">Edit</button>
        <button class="btn-small danger" data-action="delete-item" data-id="${i.id}">Delete</button>
      </div>
    </div>`;
  }).join('') : `<div class="card empty">No items match. Tap <b>＋ Add item</b> to start your inventory.</div>`;
}

async function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state.formImage = await compressImage(file);
    previewImage(state.formImage);
    toast('Photo ready — tap Save to apply.');
  } catch (err) { toast(err.message, 'error'); }
}

function previewImage(src) {
  const el = $('#form-image-preview');
  if (!el) return;
  if (src) { el.src = src; el.style.display = 'block'; }
  else el.style.display = 'none';
}

async function fillEditForm(id) {
  const item = await getItem(id);
  if (!item) return;
  state.formImage = safeImg(item);
  const set = (k, v) => { const el = $('#f-' + k); if (el) el.value = v ?? ''; };
  set('name', item.name); set('sku', item.sku); set('category', item.category);
  set('unit', item.unit || 'pcs'); set('price', item.price); set('cost', item.cost);
  set('stock', item.stock); set('reorder', item.reorderLevel ?? 5);
  set('expiry', item.expiryDate); set('supplier', item.supplier); set('notes', item.notes);
  previewImage(state.formImage);
}

async function startEdit(id) {
  state.editingId = id; state.showForm = true;
  await renderInventory();
  $('#item-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#f-name').focus();
}

async function saveItemFromForm() {
  const name = $('#f-name').value.trim();
  const price = Number($('#f-price').value);
  const cost = Number($('#f-cost').value) || 0;
  const stock = parseInt($('#f-stock').value, 10) || 0;
  const sku = $('#f-sku').value.trim();

  if (!name) return toast('Enter an item name.', 'error');
  if (!Number.isFinite(price) || price < 0) return toast('Enter a valid selling price.', 'error');
  if (cost < 0 || stock < 0) return toast('Cost and stock cannot be negative.', 'error');
  if (sku && state.items.some(i => i.sku === sku && i.id !== state.editingId))
    return toast('That SKU is already used by another item.', 'error');

  try {
    const existing = state.editingId ? await getItem(state.editingId) : null;
    const item = {
      name, sku,
      category: $('#f-category').value.trim() || 'Other',
      unit: $('#f-unit').value,
      price, cost, stock,
      reorderLevel: parseInt($('#f-reorder').value, 10) || 5,
      expiryDate: $('#f-expiry').value || '',
      supplier: $('#f-supplier').value.trim(),
      notes: $('#f-notes').value.trim(),
      image: state.formImage || '',
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (existing) item.id = existing.id;

    await saveItem(item);
    state.editingId = null; state.showForm = false; state.formImage = '';
    await renderInventory();
    toast(existing ? 'Item updated.' : 'Item saved offline.');
  } catch (err) { toast('Save failed: ' + err.message, 'error'); }
}

async function removeItem(id) {
  const item = await getItem(id);
  if (!item) return;
  if (!confirm('Delete ' + item.name + '?\nPast receipts will NOT be changed.')) return;

  await deleteItem(id);
  state.cart = state.cart.filter(l => l.itemId !== id);
  persistCart();
  if (state.editingId === id) { state.editingId = null; state.showForm = false; }
  if (state.view === 'inventory') await renderInventory(); else await renderDashboard();
  toast('Item deleted.');
}

/* ---------------- POS ---------------- */

async function renderPOS() {
  const items = await getAllItems();
  state.items = items;

  app.innerHTML = `
    <h2>Quick Sale</h2>
    <input id="pos-search" placeholder="Search item or scan SKU..." value="${esc(state.search)}">
    <div id="pos-catalog"></div>
    <section id="cart-panel" class="cart-panel"></section>`;

  $('#pos-search').oninput = e => { state.search = e.target.value; renderPOSCatalog(); };

  const saved = restoreCart();
  state.cart = saved.filter(l => items.some(i => i.id === l.itemId)).map(l => {
    const item = items.find(i => i.id === l.itemId);
    return {
      itemId: item.id, name: item.name,
      unitCents: toCents(item.price), costCents: toCents(item.cost),
      qty: Math.max(1, Math.min(Number(l.qty) || 1, Number(item.stock) || 0)),
      stock: Number(item.stock) || 0, expiryDate: item.expiryDate || ''
    };
  }).filter(l => l.qty > 0);

  persistCart();
  renderPOSCatalog();
  renderCart();
}

function renderPOSCatalog() {
  const el = $('#pos-catalog');
  if (!el) return;

  const cats = ['All', ...new Set(state.items.map(i => i.category || 'Other'))];
  if (!cats.includes(state.category)) state.category = 'All';
  const q = state.search.trim().toLowerCase();

  const list = state.items.filter(i =>
    (state.category === 'All' || (i.category || 'Other') === state.category) &&
    (!q || (i.name + ' ' + (i.sku || '')).toLowerCase().includes(q))
  );

  el.innerHTML = `
    <div class="chips">${cats.map(c => `
      <button class="chip ${state.category === c ? 'active' : ''}"
        data-action="category" data-value="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    ${list.length ? `<div class="pos-grid">${list.map(i => {
      const dl = daysLeft(i.expiryDate);
      const expired = dl !== null && dl < 0;
      const inCart = state.cart.find(l => l.itemId === i.id)?.qty || 0;
      const available = (Number(i.stock) || 0) - inCart;
      const blocked = expired || available <= 0;

      return `<button class="pos-item" data-action="add-cart" data-id="${i.id}" ${blocked ? 'disabled' : ''}>
        ${thumb(i, 60)}
        <strong>${esc(i.name)}</strong>
        <span class="price">${money(toCents(i.price))}</span>
        <small>${expired ? '⛔ EXPIRED' : available <= 0 ? 'Sold out' : i.stock + ' left' + (inCart ? ' · ' + inCart + ' in cart' : '')}</small>
      </button>`;
    }).join('')}</div>` : `<div class="card empty">No items found. Add stock in the Inventory tab.</div>`}`;
}

async function addToCart(id) {
  const item = await getItem(id);
  if (!item) return;

  const dl = daysLeft(item.expiryDate);
  if (dl !== null && dl < 0) return toast('This item is expired. Remove it from the shelf.', 'error');

  const line = state.cart.find(l => l.itemId === id);
  const inCart = line ? line.qty : 0;

  if (inCart >= (Number(item.stock) || 0)) return toast('No more stock of ' + item.name, 'error');

  if (line) line.qty++;
  else state.cart.push({
    itemId: item.id, name: item.name,
    unitCents: toCents(item.price), costCents: toCents(item.cost),
    qty: 1, stock: Number(item.stock) || 0, expiryDate: item.expiryDate || ''
  });

  persistCart(); renderCart(); renderPOSCatalog();
}

async function changeQty(id, delta) {
  const line = state.cart.find(l => l.itemId === id);
  if (!line) return;
  const item = await getItem(id);
  if (!item) { state.cart = state.cart.filter(l => l.itemId !== id); }
  else {
    line.qty += delta;
    line.stock = Number(item.stock) || 0;
    if (line.qty > line.stock) { line.qty = line.stock; toast('That is all the stock available.', 'error'); }
    if (line.qty <= 0) state.cart = state.cart.filter(l => l.itemId !== id);
  }
  persistCart(); renderCart(); renderPOSCatalog();
}

function cartTotals() {
  const subtotal = state.cart.reduce((sum, l) => sum + l.unitCents * l.qty, 0);
  const discount = Math.max(0, Math.min(subtotal, toCents(state.discount)));
  return { subtotal, discount, total: subtotal - discount };
}

function totalsHTML(t) {
  return `<div class="total-line"><span>Subtotal</span><b>${money(t.subtotal)}</b></div>
    ${t.discount ? `<div class="total-line"><span>Discount</span><b>−${money(t.discount)}</b></div>` : ''}
    <div class="total-line grand"><span>TOTAL</span><b>${money(t.total)}</b></div>`;
}

function renderCart() {
  const el = $('#cart-panel');
  if (!el) return;
  const t = cartTotals();
  const count = state.cart.reduce((sum, l) => sum + l.qty, 0);

  el.innerHTML = `<div class="card">
    <div class="row-between"><h3>Cart (${count})</h3>
      <button class="link" data-action="clear-cart">Clear</button></div>

    ${state.cart.length ? state.cart.map(l => `
      <div class="cart-line">
        <div class="cart-name"><strong>${esc(l.name)}</strong><small>${money(l.unitCents)} each</small></div>
        <div class="qty-controls">
          <button data-action="qty" data-id="${l.itemId}" data-delta="-1" aria-label="Decrease">−</button>
          <span>${l.qty}</span>
          <button data-action="qty" data-id="${l.itemId}" data-delta="1" aria-label="Increase">＋</button>
        </div>
        <b>${money(l.unitCents * l.qty)}</b>
        <button class="link" data-action="remove-cart" data-id="${l.itemId}" aria-label="Remove">✕</button>
      </div>`).join('') : '<p class="muted">Tap an item above to add it to the sale.</p>'}

    <label class="muted">Discount (₱) — for promos / near-expiry markdowns</label>
    <input id="discount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(state.discount)}" placeholder="0.00">

    <div id="cart-totals">${totalsHTML(t)}</div>
    <button class="btn-primary" data-action="checkout" ${state.cart.length ? '' : 'disabled'}>
      Charge ${money(t.total)}
    </button>
  </div>`;

  $('#discount').oninput = e => {
    state.discount = e.target.value;
    $('#cart-totals').innerHTML = totalsHTML(cartTotals());
  };
}

/* ---------------- CHECKOUT / CHANGE ---------------- */

function openCheckout() {
  if (!state.cart.length) return toast('Add an item to the cart first.', 'error');
  const t = cartTotals();

  modal(`
    <div class="row-between"><h3>Payment</h3>
      <button class="icon-btn no-print" data-action="close-modal">✕</button></div>
    <p class="muted">Amount due</p>
    <h2 class="due">${money(t.total)}</h2>

    <label>Cash received<input id="cash-received" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></label>

    <div class="quick-cash">
      ${[20, 50, 100, 200, 500, 1000].map(v => `<button data-action="cash" data-value="${v}">₱${v}</button>`).join('')}
      <button data-action="cash" data-value="exact">Exact</button>
    </div>

    <div class="change-box">Change: <strong id="change-amount">${money(0)}</strong></div>
    <p class="muted" id="cash-hint">Enter cash received to enable the sale.</p>
    <button class="btn-primary" id="confirm-sale" data-action="complete-sale" disabled>Complete sale</button>
  `);

  $('#cash-received').oninput = updateChangeUI;
  setTimeout(() => $('#cash-received')?.focus(), 100);
}

function updateChangeUI() {
  const input = $('#cash-received');
  if (!input) return;
  const paid = toCents(input.value);
  const change = paid - cartTotals().total;
  const out = $('#change-amount'), btn = $('#confirm-sale'), hint = $('#cash-hint');
  if (out) { out.textContent = money(Math.max(0, change)); out.classList.toggle('negative', change < 0); }
  if (btn) btn.disabled = change < 0;
  if (hint) hint.textContent = change < 0 ? 'Not enough cash received.' : 'Ready. Change is calculated automatically.';
}

async function finishSale() {
  if (state.saving || !state.cart.length) return;
  const paidInput = $('#cash-received');
  if (!paidInput) return;

  const t = cartTotals();
  const paid = toCents(paidInput.value);
  if (paid < t.total) return toast('Insufficient cash received.', 'error');

  state.saving = true;
  const btn = $('#confirm-sale');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const sale = {
      receiptNo: 'TND-' + Date.now().toString(36).toUpperCase(),
      createdAt: new Date().toISOString(),
      payment: 'cash', status: 'completed',
      items: state.cart.map(l => ({
        itemId: l.itemId, name: l.name, qty: l.qty,
        unitPrice: l.unitCents, unitCost: l.costCents,
        lineTotal: l.unitCents * l.qty, expiryDate: l.expiryDate || null
      })),
      subtotal: t.subtotal, discount: t.discount, total: t.total,
      paid, change: paid - t.total
    };

    const id = await completeSale(sale);   // atomic: stock + receipt
    state.cart = []; state.discount = '';
    persistCart();
    closeModal();
    await showReceipt(id);
    if (state.view === 'pos') { renderPOSCatalog(); renderCart(); }
    toast('Sale saved. Stock updated.');
  } catch (err) {
    toast(err.message, 'error');
    await refreshCartPrices();
    if ($('#confirm-sale')) { $('#confirm-sale').disabled = false; $('#confirm-sale').textContent = 'Complete sale'; }
    updateChangeUI();
  } finally {
    state.saving = false;
  }
}

async function refreshCartPrices() {
  const items = await getAllItems();
  state.cart = state.cart.map(l => {
    const item = items.find(i => i.id === l.itemId);
    if (!item) return null;
    return { ...l, name: item.name, unitCents: toCents(item.price),
      costCents: toCents(item.cost), stock: Number(item.stock) || 0,
      qty: Math.min(l.qty, Number(item.stock) || 0) };
  }).filter(l => l && l.qty > 0);
  persistCart();
  if (state.view === 'pos') { renderCart(); renderPOSCatalog(); }
}

/* ---------------- RECEIPT + PRINT ---------------- */

function receiptHTML(s) {
  return `<div class="receipt" id="receipt-print">
    <h2>Tindahan POS</h2>
    <p class="muted">${esc(s.receiptNo)}</p>
    <p class="muted">${new Date(s.createdAt).toLocaleString()}</p>
    <hr>
    ${s.items.map(l => `<div class="receipt-row">
      <span>${esc(l.name)}<br><small>${l.qty} × ${money(l.unitPrice)}</small></span>
      <b>${money(l.lineTotal)}</b></div>`).join('')}
    <hr>
    <div class="receipt-row"><span>Subtotal</span><b>${money(s.subtotal)}</b></div>
    ${s.discount ? `<div class="receipt-row"><span>Discount</span><b>−${money(s.discount)}</b></div>` : ''}
    <div class="receipt-row total"><span>TOTAL</span><b>${money(s.total)}</b></div>
    <div class="receipt-row"><span>Cash</span><b>${money(s.paid)}</b></div>
    <div class="receipt-row"><span>Change</span><b>${money(s.change)}</b></div>
    <p class="store-only muted">Store copy — gross profit: ${money(s.profit || 0)}</p>
    <p class="muted">Salamat! Uwi nang masaya. 🧡</p>
  </div>`;
}

async function showReceipt(id) {
  const s = await getSale(id);
  if (!s) return toast('Receipt not found.', 'error');

  modal(`
    <div class="row-between no-print"><h3>Sale complete ✓</h3>
      <button class="icon-btn" data-action="close-modal">✕</button></div>
    ${receiptHTML(s)}
    <div class="btn-row no-print">
      <button class="btn-primary small" data-action="print">Print receipt</button>
      <button class="btn-small" data-action="close-modal">Done</button>
    </div>`);
}

/* ---------------- BACKUP (offline data safety) ---------------- */

async function exportBackup() {
  const data = {
    app: 'tindahan-pos', version: 2,
    exportedAt: new Date().toISOString(),
    items: await getAllItems(), sales: await getAllSales()
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tindahan-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Backup downloaded. Keep it somewhere safe.');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.items)) throw new Error('This is not a Tindahan backup file.');
    if (!data.items.every(i => typeof i.name === 'string' && Number.isFinite(Number(i.price))))
      throw new Error('Backup contains invalid items.');
    if (!confirm('REPLACE all current inventory and sales with this backup?\nExport your current data first if unsure.')) return;

    const items = data.items.map(i => {
      const clean = {
        ...i,
        price: Number(i.price) || 0, cost: Number(i.cost) || 0,
        stock: Math.max(0, parseInt(i.stock, 10) || 0),
        reorderLevel: parseInt(i.reorderLevel, 10) || 5,
        category: i.category || 'Other', unit: i.unit || 'pcs',
        expiryDate: i.expiryDate || '',
        image: typeof i.image === 'string' && i.image.startsWith('data:image/') ? i.image : ''
      };
      if (!Number.isInteger(clean.id) || clean.id <= 0) delete clean.id;
      return clean;
    });

    const sales = Array.isArray(data.sales) ? data.sales.filter(s => s && Array.isArray(s.items)) : [];
    await replaceAllData(items, sales);
    state.cart = []; state.discount = ''; persistCart();
    await renderDashboard();
    toast('Backup restored.');
  } catch (err) { toast(err.message, 'error'); }
}