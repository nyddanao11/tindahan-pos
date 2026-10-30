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
  // Fix: Ensure backdrop clicks also trigger our custom closeModal function
  d.onclick = e => { if (e.target === d) closeModal(); };
  return d;
}

function closeModal() { 
  const d = $('#app-modal'); 
  if (d && d.open) {
    d.close();
    
    // AGGRESSIVELY clear cart when closing modal from the POS screen
    if (state.view === 'pos') {
      state.cart = [];
      state.discount = '';
      persistCart();
      renderCart();
      renderPOSCatalog();
    }
  }
}

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
window.__bootApp = async () => {
  const appShell = document.getElementById('app-shell');
  if (appShell) appShell.hidden = false;

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
};

function updateStatus(online) {
  const dot = $('#sync-status');
  if (dot) {
    dot.className = 'status-dot ' + (online ? 'online' : 'offline');
    dot.title = online ? 'Online — data is stored on this device' : 'Offline — all features work';
  }
}

function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // Update the state so the app knows which tab is active
      state.view = btn.dataset.view; 
      
      const view = btn.dataset.view;
      if (view === 'dashboard') renderDashboard();
      if (view === 'pos') renderPOS();
      if (view === 'inventory') renderInventory();
      if (view === 'ledger') renderLedger();       // <-- MUST BE HERE
      if (view === 'reports') renderReports(); 
    });
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
     case 'close-modal': 
      closeModal(); 
      // If we are on the POS screen, ensure the cart is wiped and UI is fresh
      if (state.view === 'pos') {
        state.cart = [];
        state.discount = '';
        persistCart();
        renderCart();
        renderPOSCatalog();
      }
      break;
    case 'print': window.print(); break;
    case 'view-sale': await showReceipt(id); break;
    case 'export': await exportBackup(); break;
    case 'import': if ($('#import-file')) $('#import-file').click(); break;
    case 'export-csv': exportReportToCSV(); break;
    case 'print-report': printReport(); break;

    case 'select-payment':
      switchPaymentMethod(b.dataset.method);
      break;

    case 'quick-add-customer':
      modal(`
        <div class="row-between"><h3>Quick Add Customer</h3><button class="icon-btn" data-action="close-modal">✕</button></div>
        <label>Full Name *<input id="qac-name" required placeholder="e.g. Juan Dela Cruz"></label>
        <label>Phone Number<input id="qac-phone" type="tel" placeholder="09123456789"></label>
        <label>Address / Notes<input id="qac-notes" placeholder="Optional"></label>
        <button class="btn-primary" data-action="save-quick-customer">Save & Select</button>
      `);
      break;

    case 'save-quick-customer':
      const qName = $('#qac-name').value.trim();
      if (!qName) { toast('Name is required', 'error'); break; }
      const newCust = await saveCustomer({
        name: qName,
        phone: $('#qac-phone').value.trim(),
        address: $('#qac-notes').value.trim(),
        createdAt: new Date().toISOString()
      });
      closeModal();
      // Reopen checkout and auto-select the new customer
      openCheckout();
      setTimeout(() => {
        const select = $('#utang-customer');
        if (select) {
          select.value = newCust;
          select.dispatchEvent(new Event('change'));
        }
      }, 100);
      toast('Customer added and selected!');
      break;

      // Global click handler additions for Ledger
// ADD THESE CASES to your existing switch(a) statement in the global click listener:

    case 'new-customer':
      modal(`
        <div class="row-between"><h3>Add New Customer</h3><button class="icon-btn" data-action="close-modal">✕</button></div>
        <label>Full Name *<input id="lc-name" required placeholder="e.g. Juan Dela Cruz"></label>
        <label>Phone Number<input id="lc-phone" type="tel" placeholder="09123456789"></label>
        <label>Address / Notes<input id="lc-notes" placeholder="e.g. Blue house, corner store"></label>
        <button class="btn-primary" data-action="save-customer">Save Customer</button>
      `);
      break;
      
    case 'save-customer':
      const name = $('#lc-name').value.trim();
      if (!name) { toast('Name is required', 'error'); break; }
      await saveCustomer({
        name,
        phone: $('#lc-phone').value.trim(),
        address: $('#lc-notes').value.trim(),
        createdAt: new Date().toISOString()
      });
      closeModal();
      renderLedger();
      toast('Customer added!');
      break;

    case 'view-customer':
      await renderCustomerDetail(id);
      break;

    case 'back-to-ledger':
      renderLedger();
      break;

    case 'delete-customer':
      if (!confirm('Delete this customer and all their ledger history? This cannot be undone.')) break;
      await deleteCustomer(id);
      renderLedger();
      toast('Customer deleted.');
      break;

    case 'add-debt':
    case 'add-payment':
      const type = a === 'add-debt' ? 'debt' : 'payment';
      const title = type === 'debt' ? 'Add Utang (Debt)' : 'Add Bayad (Payment)';
      modal(`
        <div class="row-between"><h3>${title}</h3><button class="icon-btn" data-action="close-modal">✕</button></div>
        <label>Amount (₱) *<input id="lt-amount" type="number" min="1" step="0.01" required placeholder="0.00"></label>
        <label>Description<input id="lt-desc" placeholder="${type === 'debt' ? 'e.g. 2 packs of noodles, 1 coke' : 'e.g. Partial payment, salary'}"></label>
        <button class="btn-primary" data-action="save-ledger-entry" data-type="${type}" data-id="${id}">Save</button>
      `);
      break;

    case 'save-ledger-entry':
      const amt = parseFloat($('#lt-amount').value);
      if (!amt || amt <= 0) { toast('Enter a valid amount', 'error'); break; }
      await addLedgerEntry({
        customerId: id,
        type: b.dataset.type,
        amount: amt,
        description: $('#lt-desc').value.trim(),
        createdAt: new Date().toISOString()
      });
      closeModal();
      renderCustomerDetail(id);
      toast(b.dataset.type === 'debt' ? 'Utang recorded.' : 'Payment recorded!');
      break;

    
    case 'clear-old-sales':
      if (!confirm('This will permanently delete all sales older than 2 years. Export a backup first. Continue?')) return;
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 2);
      const allSales = await getAllSales();
      const oldSales = allSales.filter(s => new Date(s.createdAt) < cutoff);
      
      if (!oldSales.length) { toast('No old sales to delete.'); break; }

          case 'edit-customer':
      // Fetch fresh customer data to prefill the modal
      const allCusts = await getAllCustomers();
      const custToEdit = allCusts.find(c => c.id === id);
      if (!custToEdit) break;
      
      modal(`
        <div class="row-between"><h3>Edit Customer Profile</h3><button class="icon-btn" data-action="close-modal">✕</button></div>
        <label>Full Name *<input id="lec-name" required value="${esc(custToEdit.name)}"></label>
        <label>Phone Number<input id="lec-phone" type="tel" value="${esc(custToEdit.phone || '')}"></label>
        <label>Address / Notes<input id="lec-notes" value="${esc(custToEdit.address || '')}"></label>
        <button class="btn-primary" data-action="save-customer-edit" data-id="${custToEdit.id}">Update Customer</button>
      `);
      break;

    case 'save-customer-edit':
      const editName = $('#lec-name').value.trim();
      if (!editName) { toast('Name is required', 'error'); break; }
      
      // Find original creation date to preserve it
      const originalCust = (await getAllCustomers()).find(c => c.id === Number(b.dataset.id));
      
      await saveCustomer({
        id: Number(b.dataset.id), // Passing the ID tells saveCustomer to UPDATE, not create new
        name: editName,
        phone: $('#lec-phone').value.trim(),
        address: $('#lec-notes').value.trim(),
        createdAt: originalCust ? originalCust.createdAt : new Date().toISOString()
      });
      
      closeModal();
      renderCustomerDetail(Number(b.dataset.id)); // Refresh the screen with new data
      toast('Customer profile updated!');
      break;
      
      // Note: 'db' is globally available from db.js
      const t = db.transaction('sales', 'readwrite');
      oldSales.forEach(s => t.objectStore('sales').delete(s.id));
      t.oncomplete = () => {
        toast(`Deleted ${oldSales.length} old sales.`);
        renderDashboard();
      };
      t.onerror = () => toast('Failed to delete old sales.', 'error');
      break;
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

   // Add storage check here
  const storage = await checkStorageUsage();
  const storageWarning = (storage && storage.percentUsed > 80) 
    ? `<div class="card attention">
        <p class="warn-text">⚠️ Storage is ${storage.percentUsed}% full (${storage.usedMB} MB / ${storage.quotaMB} MB)</p>
        <p class="muted">Consider exporting a backup and clearing old sales.</p>
       </div>` 
    : '';

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
      <p class="muted">Your inventory and receipts live in THIS browser on THIS device. Clearing browser data deletes them. Export a backup weekly.</p>
      <div class="btn-row">
        <button class="btn-primary small" data-action="export">Export backup</button>
        <button class="btn-small" data-action="import">Import backup</button>
      </div>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
    </div>

    <div class="card">
      <h3>Data Management</h3>
      <p class="muted">You have <strong>${sales.length}</strong> sales records.</p>
      <p class="muted">Oldest: ${sales.length ? new Date(sales[sales.length-1].createdAt).toLocaleDateString() : 'N/A'}</p>
      <button class="btn-small danger" data-action="clear-old-sales" style="margin-top:8px;">
        Delete Sales Older Than 2 Years
      </button>
    </div>

        <!-- Professional App Footer -->
    <div class="app-footer">
      Tindahan POS v6.0 • Secure offline technology by <a href="https://yeilvastore.com" target="_blank" class="footer-link">Yeilvastore</a>
    </div>
  `;


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
                   <label>Category
          <select id="f-category-select" style="margin-bottom: 5px;">
            ${cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
            <option value="__custom__">✏️ Other (Type custom below)</option>
          </select>
          <input type="text" id="f-category-custom" placeholder="Enter custom category name..." hidden>
        </label>

        <label>Selling unit
          <select id="f-unit">${['pcs', 'pack', 'box', 'kg', 'liter', 'can'].map(u => `<option>${u}</option>`).join('')}</select>
        </label>
        <label>Price (sell) *<input id="f-price" type="number" min="0" step="0.01" required placeholder="15.00"></label>
        <label>Cost (you pay)<input id="f-cost" type="number" min="0" step="0.01" placeholder="12.00">
          <small class="muted">Per selling unit — not per case.</small>
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
    // Handle custom category toggle
  $('#f-category-select').onchange = (e) => {
    const customInput = $('#f-category-custom');
    if (e.target.value === '__custom__') {
      customInput.hidden = false;
      customInput.focus();
    } else {
      customInput.hidden = true;
      customInput.value = '';
    }
  };

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
     category: (() => {
        const selectVal = $('#f-category-select').value;
        const customVal = $('#f-category-custom')?.value.trim();
        if (selectVal === '__custom__' && customVal) return customVal;
        if (selectVal === '__custom__') return 'Other';
        return selectVal || 'Other';
      })(),
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
    <div class="row-between">
      <h2>Quick Sale</h2>
      <button class="btn-small" id="btn-scan-barcode" style="display:flex; align-items:center; gap:6px;">
        📷 Scan Barcode
      </button>
    </div>
    <input id="pos-search" placeholder="Search item or scan SKU..." value="${esc(state.search)}">
    <div id="pos-catalog"></div>
    <section id="cart-panel" class="cart-panel"></section>
    
    <!-- Scanner Modal Container (Hidden by default) -->
    <div id="scanner-modal" class="scanner-modal" hidden>
      <div class="scanner-box">
        <div class="row-between">
          <h3>Scan Barcode</h3>
          <button class="icon-btn" id="close-scanner">✕</button>
        </div>
        <div id="reader" style="width: 100%; border-radius: 8px; overflow: hidden; margin-top: 10px;"></div>
        <p class="muted text-center" style="margin-top: 10px;">Point camera at the product barcode</p>
      </div>
    </div>
  `;
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
  setupScanner(); // <-- ADD THIS LINE
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

    <!-- Optional Customer Name -->
    <label>Customer Name (optional)<input id="customer-name" type="text" placeholder="e.g. Juan Dela Cruz — for receipt"></label>

    <!-- Payment Method Selector -->
    <label>Payment Method</label>
    <div class="payment-methods">
      <button class="pay-method active" data-method="cash" data-action="select-payment">💵 Cash</button>
      <button class="pay-method" data-method="ewallet" data-action="select-payment">📱 E-Wallet</button>
      <button class="pay-method" data-method="utang" data-action="select-payment">📒 Utang</button>
    </div>

    <!-- Cash Section (Default) -->
    <div id="cash-section">
      <label>Cash received<input id="cash-received" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></label>
      <div class="quick-cash">
        ${[20, 50, 100, 200, 500, 1000].map(v => `<button data-action="cash" data-value="${v}">₱${v}</button>`).join('')}
        <button data-action="cash" data-value="exact">Exact</button>
      </div>
      <div class="change-box">Change: <strong id="change-amount">${money(0)}</strong></div>
    </div>

    <!-- E-Wallet Section (Hidden by default) -->
    <div id="ewallet-section" hidden>
      <label>E-Wallet Provider
        <select id="ewallet-provider">
          <option value="GCash">GCash</option>
          <option value="Maya">Maya</option>
          <option value="GrabPay">GrabPay</option>
          <option value="PayMaya">PayMaya</option>
          <option value="Other E-Wallet">Other</option>
        </select>
      </label>
      <label>Reference Number (optional)<input id="ewallet-ref" type="text" placeholder="e.g. 123456789"></label>
      <p class="muted" style="text-align:center; padding:10px; background:#E8F8F0; border-radius:8px;">✓ Confirm payment received from customer</p>
    </div>

    <!-- Utang Section (Hidden by default) -->
    <div id="utang-section" hidden>
      <label>Select Customer *</label>
      <select id="utang-customer">
        <option value="">— Choose existing customer —</option>
      </select>
      <button class="btn-small" data-action="quick-add-customer" style="width:100%; margin-bottom:10px;">＋ Add new customer now</button>
      <label>Due Date<input id="utang-due" type="date"></label>
      <label>Notes<input id="utang-notes" placeholder="e.g. Bayad sa sweldo"></label>
    </div>

    <p class="muted" id="cash-hint">Enter cash received to enable the sale.</p>
    <button class="btn-primary" id="confirm-sale" data-action="complete-sale" disabled>Complete sale</button>
  `);

  // Load customers into utang dropdown
  loadUtangCustomers();

  // Set default date to 30 days from now
  const defaultDue = new Date();
  defaultDue.setDate(defaultDue.getDate() + 30);
  const dueInput = document.getElementById('utang-due');
  if (dueInput) dueInput.value = defaultDue.toISOString().split('T')[0];

  // Enable cash input listener
  const cashInput = $('#cash-received');
  if (cashInput) cashInput.oninput = updateChangeUI;
  
  // Auto-enable for cash when exact amount entered
  updateChangeUI();
  
  setTimeout(() => $('#cash-received')?.focus(), 100);
}

async function loadUtangCustomers() {
  const customers = await getAllCustomers();
  const select = $('#utang-customer');
  if (!select) return;
  
  customers.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name}${c.phone ? ' · ' + c.phone : ''}`;
    select.appendChild(opt);
  });
}

function switchPaymentMethod(method) {
  // Update button styles
  document.querySelectorAll('.pay-method').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === method);
  });

  // Show/hide sections
  $('#cash-section').hidden = method !== 'cash';
  $('#ewallet-section').hidden = method !== 'ewallet';
  $('#utang-section').hidden = method !== 'utang';

  // Update confirm button state
  const btn = $('#confirm-sale');
  const hint = $('#cash-hint');
  
  if (method === 'cash') {
    updateChangeUI();
    if (hint) hint.textContent = 'Enter cash received to enable the sale.';
  } else if (method === 'ewallet') {
    btn.disabled = false;
    if (hint) hint.textContent = 'Confirm e-wallet payment received.';
  } else if (method === 'utang') {
    const hasCustomer = $('#utang-customer').value !== '';
    btn.disabled = !hasCustomer;
    if (hint) hint.textContent = hasCustomer 
      ? 'This sale will be recorded as utang (credit).' 
      : 'Select a customer to record utang.';
    
    // Add listener for customer selection
    $('#utang-customer').onchange = () => {
      btn.disabled = $('#utang-customer').value === '';
      if (hint) hint.textContent = $('#utang-customer').value 
        ? 'This sale will be recorded as utang (credit).' 
        : 'Select a customer to record utang.';
    };
  }
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

  // Determine payment method
  const activeMethod = document.querySelector('.pay-method.active');
  const method = activeMethod ? activeMethod.dataset.method : 'cash';

  const t = cartTotals();
  const customerName = $('#customer-name')?.value.trim() || '';

  let paid = 0, change = 0, ewalletProvider = '', ewalletRef = '';
  let customerId = null, dueDate = null, utangNotes = '';

  if (method === 'cash') {
    const paidInput = $('#cash-received');
    if (!paidInput) return;
    paid = toCents(paidInput.value);
    if (paid < t.total) return toast('Insufficient cash received.', 'error');
    change = paid - t.total;
  } else if (method === 'ewallet') {
    paid = t.total;
    change = 0;
    ewalletProvider = $('#ewallet-provider')?.value || 'E-Wallet';
    ewalletRef = $('#ewallet-ref')?.value.trim() || '';
  } else if (method === 'utang') {
    customerId = Number($('#utang-customer').value);
    if (!customerId) return toast('Please select a customer for utang.', 'error');
    paid = 0; // No cash paid
    change = 0;
    dueDate = $('#utang-due')?.value || '';
    utangNotes = $('#utang-notes')?.value.trim() || '';
  }

  state.saving = true;
  const btn = $('#confirm-sale');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const sale = {
      receiptNo: 'TND-' + Date.now().toString(36).toUpperCase(),
      createdAt: new Date().toISOString(),
      paymentMethod: method,
      payment: method, // backward compatibility
      customerName,
      customerId,
      ewalletProvider,
      ewalletRef,
      dueDate,
      utangNotes,
      status: method === 'utang' ? 'utang' : 'completed',
      items: state.cart.map(l => ({
        itemId: l.itemId, name: l.name, qty: l.qty,
        unitPrice: l.unitCents, unitCost: l.costCents,
        lineTotal: l.unitCents * l.qty, expiryDate: l.expiryDate || null
      })),
      subtotal: t.subtotal, discount: t.discount, total: t.total,
      paid, change
    };

    const saleId = await completeSale(sale);

    // If utang, automatically create a ledger entry
    if (method === 'utang' && customerId) {
      await addLedgerEntry({
        customerId,
        type: 'debt',
        amount: t.total / 100, // Convert cents to pesos
        description: `Purchase ${sale.receiptNo}${utangNotes ? ' — ' + utangNotes : ''}${dueDate ? ' · Due: ' + dueDate : ''}`,
        saleId: saleId,
        createdAt: new Date().toISOString()
      });
    }

    state.cart = []; state.discount = '';
    persistCart();
    closeModal();
    await showReceipt(saleId);
    if (state.view === 'pos') { renderPOSCatalog(); renderCart(); }
    toast(method === 'utang' ? 'Utang recorded in ledger.' : 'Sale saved. Stock updated.');
  } catch (err) {
    toast(err.message, 'error');
    await refreshCartPrices();
    if ($('#confirm-sale')) { $('#confirm-sale').disabled = false; $('#confirm-sale').textContent = 'Complete sale'; }
    if (method === 'cash') updateChangeUI();
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
  const method = s.paymentMethod || s.payment || 'cash';
  const methodLabel = method === 'cash' ? '💵 Cash' 
    : method === 'ewallet' ? `📱 ${s.ewalletProvider || 'E-Wallet'}` 
    : '📒 Utang (Credit)';

  return `<div class="receipt" id="receipt-print">
    <h2>Tindahan POS</h2>
    <p class="muted">${esc(s.receiptNo)}</p>
    <p class="muted">${new Date(s.createdAt).toLocaleString()}</p>
    ${s.customerName ? `<p style="text-align:center; font-weight:600; margin-top:8px;">Customer: ${esc(s.customerName)}</p>` : ''}
    <hr>
    ${s.items.map(l => `<div class="receipt-row">
      <span>${esc(l.name)}<br><small>${l.qty} × ${money(l.unitPrice)}</small></span>
      <b>${money(l.lineTotal)}</b></div>`).join('')}
    <hr>
    <div class="receipt-row"><span>Subtotal</span><b>${money(s.subtotal)}</b></div>
    ${s.discount ? `<div class="receipt-row"><span>Discount</span><b>−${money(s.discount)}</b></div>` : ''}
    <div class="receipt-row total"><span>TOTAL</span><b>${money(s.total)}</b></div>
    
    ${method === 'utang' ? `
      <div class="receipt-row" style="background:#FFF4E0; padding:8px; border-radius:6px; margin-top:6px;">
        <span><strong>📒 UTANG</strong></span>
        <strong>Balance: ${money(s.total)}</strong>
      </div>
      ${s.dueDate ? `<p class="muted" style="text-align:center; margin-top:6px;">Due: ${esc(s.dueDate)}</p>` : ''}
    ` : method === 'ewallet' ? `
      <div class="receipt-row"><span>Payment</span><b>${esc(methodLabel)}</b></div>
      ${s.ewalletRef ? `<div class="receipt-row"><span>Ref #</span><b>${esc(s.ewalletRef)}</b></div>` : ''}
    ` : `
      <div class="receipt-row"><span>Cash</span><b>${money(s.paid)}</b></div>
      <div class="receipt-row"><span>Change</span><b>${money(s.change)}</b></div>
    `}
    
    <br>
    <p class="muted" style="text-align:center; font-weight:600;">Salamat! Uwi nang masaya. 🧡</p>
    
    <div style="margin-top: 15px; border-top: 1px dashed #ccc; padding-top: 8px; text-align: center;">
      <p style="font-size: 9px; color: #999; margin: 0;">Secure POS Technology by Yeilvastore</p>
    </div>
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

/* ── BACKUP EXPORT/IMPORT LOGIC ── */

async function exportBackup() {
  const data = {
    app: 'tindahan-pos', version: 4, // Updated version
    exportedAt: new Date().toISOString(),
    items: await getAllItems(), 
    sales: await getAllSales(),
    customers: await getAllCustomers(), // NEW
    ledger: await db.transaction('ledger').objectStore('ledger').getAll() // NEW
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
    if (!Array.isArray(data.items)) throw new Error('Invalid backup file.');
    if (!confirm('REPLACE all current data with this backup? Export current data first if unsure.')) return;

    const items = data.items.map(i => ({ ...i, price: Number(i.price)||0, cost: Number(i.cost)||0, stock: Math.max(0, parseInt(i.stock,10)||0) }));
    const sales = Array.isArray(data.sales) ? data.sales.filter(s => s && Array.isArray(s.items)) : [];
    const customers = Array.isArray(data.customers) ? data.customers : []; // NEW
    const ledger = Array.isArray(data.ledger) ? data.ledger : []; // NEW
    
    await replaceAllData(items, sales, customers, ledger);
    state.cart = []; state.discount = ''; persistCart();
    await renderDashboard();
    toast('Backup restored successfully.');
  } catch (err) { toast(err.message, 'error'); }
}

/* ── BARCODE SCANNER LOGIC ── */
let html5QrCode = null;
let isScanning = false;

function setupScanner() {
  const scanBtn = document.getElementById('btn-scan-barcode');
  const closeBtn = document.getElementById('close-scanner');
  const modal = document.getElementById('scanner-modal');

  if (scanBtn) {
    scanBtn.addEventListener('click', () => {
      modal.hidden = false;
      startScanning();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      stopScanning();
      modal.hidden = true;
    });
  }
}

function startScanning() {
  if (isScanning) return;
  
  // Check if library loaded
  if (typeof Html5Qrcode === 'undefined') {
    toast('Scanner library not loaded. Check internet and reload.', 'error');
    return;
  }

  html5QrCode = new Html5Qrcode("reader");
  isScanning = true;

  const config = { fps: 10, qrbox: { width: 250, height: 150 }, aspectRatio: 1.0 };
  
  // Prefer back camera on mobile
  html5QrCode.start(
    { facingMode: "environment" }, 
    config, 
    async (decodedText, decodedResult) => {
      // SUCCESS: Barcode detected!
      stopScanning();
      document.getElementById('scanner-modal').hidden = true;
      await handleScannedBarcode(decodedText);
    },
    (errorMessage) => {
      // Ignore continuous scan errors, this is normal while searching for a code
    }
  ).catch((err) => {
    console.error("Camera error:", err);
    toast('Camera access denied or not available.', 'error');
    stopScanning();
    document.getElementById('scanner-modal').hidden = true;
  });
}

function stopScanning() {
  if (html5QrCode && isScanning) {
    html5QrCode.stop().then(() => {
      html5QrCode.clear();
      isScanning = false;
    }).catch(err => console.error("Failed to stop scanner", err));
  }
}

async function handleScannedBarcode(scannedCode) {
  // Clean the scanned code (remove any accidental whitespace)
  const cleanCode = scannedCode.trim();
  
  // Find item by SKU/Barcode
  const items = await getAllItems();
  const matchedItem = items.find(i => i.sku && i.sku.trim().toLowerCase() === cleanCode.toLowerCase());

  if (matchedItem) {
    toast(`Found: ${matchedItem.name}`);
    await addToCart(matchedItem.id);
  } else {
    toast(`Item not found for barcode: ${cleanCode}`, 'error');
    // Optional: Auto-focus the search bar so they can type it manually
    const searchInput = document.getElementById('pos-search');
    if (searchInput) {
      searchInput.value = cleanCode;
      state.search = cleanCode;
      renderPOSCatalog();
    }
  }
}

/* ── LEDGER / PAUTANG SYSTEM ── */
async function renderLedger() {
  const customers = await getAllCustomers();
  
  app.innerHTML = `
    <div class="row-between">
      <h2>Customer Ledger</h2>
      <button class="btn-primary small" data-action="new-customer">＋ Add Customer</button>
    </div>
    <input id="ledger-search" placeholder="Search customer name..." style="margin-bottom: 12px;">
    <div id="ledger-list"></div>
  `;

  $('#ledger-search').oninput = (e) => renderLedgerList(customers, e.target.value.trim().toLowerCase());
  renderLedgerList(customers, '');
}

async function renderLedgerList(customers, query) {
  const filtered = customers.filter(c => !query || c.name.toLowerCase().includes(query));
  const listEl = $('#ledger-list');
  
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="card empty">No customers found. Tap "＋ Add Customer" to start tracking pautang.</div>`;
    return;
  }

  // Calculate balance for each customer
  const listWithBalance = await Promise.all(filtered.map(async (c) => {
    const transactions = await getCustomerLedger(c.id);
    const balance = transactions.reduce((sum, t) => {
      return t.type === 'debt' ? sum + t.amount : sum - t.amount;
    }, 0);
    return { ...c, balance };
  }));

  listEl.innerHTML = listWithBalance.map(c => `
    <div class="card ledger-customer-row" data-action="view-customer" data-id="${c.id}">
      <div class="ledger-info">
        <strong>${esc(c.name)}</strong>
        <small class="muted">${c.phone ? '📞 ' + esc(c.phone) : 'No phone'}</small>
      </div>
      <div class="ledger-balance ${c.balance > 0 ? 'text-danger' : 'text-success'}">
        ${c.balance > 0 ? 'Utang: ' + money(c.balance * 100) : 'Settled'}
      </div>
    </div>
  `).join('');
}

async function renderCustomerDetail(customerId) {
  const customer = await getAllCustomers().then(c => c.find(x => x.id === customerId));
  if (!customer) return renderLedger();
  
  const transactions = await getCustomerLedger(customerId);
  const balance = transactions.reduce((sum, t) => t.type === 'debt' ? sum + t.amount : sum - t.amount, 0);

  app.innerHTML = `
    <div class="row-between">
      <button class="btn-small" data-action="back-to-ledger">← Back</button>
      <button class="btn-small danger" data-action="delete-customer" data-id="${customer.id}">Delete</button>
    </div>
    
    <div class="card" style="text-align:center; margin-top:12px;">
      <h2 style="margin:0;">${esc(customer.name)}</h2>
      <p class="muted">${customer.phone ? '📞 ' + esc(customer.phone) : ''} ${customer.address ? '· 📍 ' + esc(customer.address) : ''}</p>
      <h1 class="${balance > 0 ? 'text-danger' : 'text-success'}" style="font-size:32px; margin:10px 0;">
        ${balance > 0 ? 'Total Utang: ' + money(balance * 100) : 'Balanced (₱0.00)'}
      </h1>
      <div class="btn-row" style="justify-content:center; margin-top:16px; flex-wrap: wrap; gap: 8px;">
        <button class="btn-small" data-action="edit-customer" data-id="${customer.id}">✏️ Edit Profile</button>
        <button class="btn-primary small" data-action="add-debt" data-id="${customer.id}">＋ Add Utang</button>
        <button class="btn-small" style="background:#E8F8F0; color:#1E8E5A;" data-action="add-payment" data-id="${customer.id}">💵 Add Bayad</button>
        ${customer.phone ? `<a href="sms:${customer.phone}?body=Hi ${esc(customer.name)}, reminder lang po na may natitirang utang na ${money(balance * 100)} sa tindahan. Salamat!" class="btn-small" style="text-decoration:none; display:inline-flex; align-items:center;">📩 SMS</a>` : ''}
      </div>
    </div>

    <h3 style="margin-top:20px;">Transaction History</h3>
    <div id="ledger-history">
      ${transactions.length ? transactions.map(t => `
        <div class="card" style="padding:12px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong>${t.type === 'debt' ? '🛒 Utang' : '💵 Bayad'}</strong>
            <small class="muted" style="display:block;">${esc(t.description || 'No details')} · ${new Date(t.createdAt).toLocaleDateString('en-PH')}</small>
          </div>
          <strong class="${t.type === 'debt' ? 'text-danger' : 'text-success'}">
            ${t.type === 'debt' ? '+' : '-'}${money(t.amount * 100)}
          </strong>
        </div>
      `).join('') : '<p class="muted text-center">No transactions yet.</p>'}
    </div>
  `;
}

/* ── MONTHLY REPORTS & EXPORT ── */
async function renderReports() {
  const sales = await getAllSales();
  const today = new Date();
  const currentMonth = today.getMonth() + 1;
  const currentYear = today.getFullYear();

  app.innerHTML = `
    <div class="row-between">
      <h2>Monthly Reports</h2>
    </div>
    
    <div class="card">
      <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
        <label>Month
          <select id="report-month">
            ${Array.from({length: 12}, (_, i) => {
              const m = i + 1;
              return `<option value="${m}" ${m === currentMonth ? 'selected' : ''}>${new Date(0, m - 1).toLocaleString('en-PH', { month: 'long' })}</option>`;
            }).join('')}
          </select>
        </label>
        <label>Year
          <select id="report-year">
            ${[currentYear - 1, currentYear, currentYear + 1].map(y => 
              `<option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}</option>`
            ).join('')}
          </select>
        </label>
      </div>
      <button class="btn-primary" id="generate-report-btn">Generate Report</button>
    </div>

    <div id="report-results" class="card" hidden>
      <div class="row-between">
        <h3 id="report-title">Report</h3>
        <div class="btn-row">
          <button class="btn-small" data-action="print-report">🖨️ Print PDF</button>
          <button class="btn-small" data-action="export-csv">📊 Export Excel (CSV)</button>
        </div>
      </div>
      <div class="stats-grid" style="margin-top: 16px;">
        <div class="stat"><small>Total Sales</small><strong id="rep-total-sales">₱0.00</strong></div>
        <div class="stat green"><small>Total Profit</small><strong id="rep-total-profit">₱0.00</strong></div>
        <div class="stat"><small>Transactions</small><strong id="rep-tx-count">0</strong></div>
      </div>
      <div class="table-responsive" style="margin-top: 16px; overflow-x: auto;">
        <table class="report-table" id="report-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Receipt</th>
              <th>Items</th>
              <th>Total</th>
              <th>Profit</th>
            </tr>
          </thead>
          <tbody id="report-tbody"></tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('generate-report-btn').addEventListener('click', () => {
    const m = parseInt(document.getElementById('report-month').value);
    const y = parseInt(document.getElementById('report-year').value);
    generateReportData(sales, m, y);
  });
}

function generateReportData(allSales, month, year) {
  const filtered = allSales.filter(s => {
    const d = new Date(s.createdAt);
    return (d.getMonth() + 1) === month && d.getFullYear() === year;
  });

  filtered.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const totalRevenue = filtered.reduce((sum, s) => sum + s.total, 0);
  const totalProfit = filtered.reduce((sum, s) => sum + (s.profit || 0), 0);
  const monthName = new Date(year, month - 1).toLocaleString('en-PH', { month: 'long', year: 'numeric' });

  document.getElementById('report-title').textContent = `Report: ${monthName}`;
  document.getElementById('rep-total-sales').textContent = money(totalRevenue);
  document.getElementById('rep-total-profit').textContent = money(totalProfit);
  document.getElementById('rep-tx-count').textContent = filtered.length;
  document.getElementById('report-results').hidden = false;

  const tbody = document.getElementById('report-tbody');
  tbody.innerHTML = filtered.map(s => {
    const date = new Date(s.createdAt).toLocaleDateString('en-PH');
    const itemsSummary = s.items.map(i => `${i.name} (x${i.qty})`).join(', ');
    return `
      <tr>
        <td>${date}</td>
        <td>${esc(s.receiptNo)}</td>
        <td style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${esc(itemsSummary)}">${esc(itemsSummary)}</td>
        <td>${money(s.total)}</td>
        <td class="text-success">${money(s.profit || 0)}</td>
      </tr>
    `;
  }).join('');

  window._currentReportData = { monthName, filtered };
}

function exportReportToCSV() {
  if (!window._currentReportData) return;
  const { monthName, filtered } = window._currentReportData;

  let csv = '\uFEFF'; 
  csv += `Tindahan POS Monthly Report - ${monthName}\n\n`;
  csv += 'Date,Receipt No,Items,Subtotal,Discount,Total,Profit,Payment\n';

  filtered.forEach(s => {
    const date = new Date(s.createdAt).toLocaleDateString('en-PH');
    const items = s.items.map(i => `${i.name} x${i.qty}`).join('; ');
    const safeItems = `"${items.replace(/"/g, '""')}"`; 
    
    csv += `${date},${s.receiptNo},${safeItems},${s.subtotal/100},${s.discount/100},${s.total/100},${(s.profit||0)/100},${s.payment}\n`;
  });

  const totalRev = filtered.reduce((sum, s) => sum + s.total, 0) / 100;
  const totalProf = filtered.reduce((sum, s) => sum + (s.profit || 0), 0) / 100;
  csv += `\n,,,TOTAL,,${totalRev.toFixed(2)},${totalProf.toFixed(2)},\n`;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Tindahan_Report_${monthName.replace(' ', '_')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Excel (CSV) report downloaded!');
}

function printReport() {
  if (!window._currentReportData) return;
  const { monthName, filtered } = window._currentReportData;
  
  const totalRev = filtered.reduce((sum, s) => sum + s.total, 0);
  const totalProf = filtered.reduce((sum, s) => sum + (s.profit || 0), 0);

  let printDiv = document.getElementById('print-container');
  if (!printDiv) {
    printDiv = document.createElement('div');
    printDiv.id = 'print-container';
    document.body.appendChild(printDiv);
  }

  printDiv.innerHTML = `
    <div class="print-report">
      <h1>Tindahan POS</h1>
      <h2>Monthly Sales Report: ${monthName}</h2>
      <p>Generated: ${new Date().toLocaleString('en-PH')}</p>
      <hr>
      <table class="print-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Receipt</th>
            <th>Items</th>
            <th>Total</th>
            <th>Profit</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(s => `
            <tr>
              <td>${new Date(s.createdAt).toLocaleDateString('en-PH')}</td>
              <td>${s.receiptNo}</td>
              <td>${s.items.map(i => `${i.name} (x${i.qty})`).join(', ')}</td>
              <td>₱${(s.total/100).toFixed(2)}</td>
              <td>₱${((s.profit||0)/100).toFixed(2)}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="text-align:right; font-weight:bold;">TOTALS:</td>
            <td style="font-weight:bold;">₱${(totalRev/100).toFixed(2)}</td>
            <td style="font-weight:bold;">₱${(totalProf/100).toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;

  window.print();
}