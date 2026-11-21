import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoViewer, createViewerImageCache } from '../public/viewer.js';
import { setupAdmin } from '../public/admin.js';
import { defaults, validateSettings } from '../public/settings.js';
import { setupLibraryMenus } from '../public/library.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(tag = 'div', id) {
    this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.className = ''; this.value = '';
    this.clientWidth = 1000; this.clientHeight = 500; this.offsetHeight = 120;
    this.classList = {
      contains: name => this.className.split(' ').includes(name),
      toggle: (name, active = !this.classList.contains(name)) => { const names = new Set(this.className.split(' ').filter(Boolean)); if (active) names.add(name); else names.delete(name); this.className = [...names].join(' '); },
      add: name => this.classList.toggle(name, true), remove: name => this.classList.toggle(name, false),
    };
  }
  set textContent(value) { this._text = value; this.replaceChildren(); }
  get textContent() { return this._text || ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...nodes) { nodes.forEach(node => this.insertBefore(node, null)); }
  insertBefore(node, next) { node.remove(); this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, node); node.parent = this; }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  replaceWith(node) { const parent = this.parent, next = parent.children[parent.children.indexOf(this) + 1]; this.remove(); parent.insertBefore(node, next); }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  matches(selector) { return selector.startsWith('#') ? this.id === selector.slice(1) : selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : selector === '[data-key-type]' ? Boolean(this.dataset.keyType) : this.tagName.toLowerCase() === selector; }
  querySelectorAll(selector) { const nodes = []; for (const child of this.children) { if (child.matches(selector)) nodes.push(child); nodes.push(...child.querySelectorAll(selector)); } return nodes; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, event) { for (const fn of this.listeners[name] || []) fn(event); }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  setPointerCapture() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close', {}); }
  showPopover() { this.emit('toggle', { newState: 'open' }); }
  hidePopover() { this.emit('toggle', { newState: 'closed' }); }
  reportValidity() { return true; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 200, bottom: 45, width: 190 }; }
}
function environment(t, root) {
  const values = { document: globalThis.document, window: globalThis.window, Image: globalThis.Image, innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight };
  globalThis.document = { querySelector: selector => root.matches(selector) ? root : root.querySelector(selector), createElement: tag => new Element(tag) };
  globalThis.window = { addEventListener() {} }; globalThis.innerWidth = 1200; globalThis.innerHeight = 800;
  t.after(() => { Object.assign(globalThis, values); });
  const images = [];
  globalThis.Image = class extends Element {
    constructor() { super('img'); images.push(this); }
    async decode() { this.decoded = true; }
    load() { this.naturalWidth = 1600; this.naturalHeight = 800; this.onload?.(); }
    fail() { this.onerror?.(); }
  };
  return images;
}
function add(root, id, tag = 'div') { const node = new Element(tag, id); root.append(node); return node; }

function libraryMenus() {
  const dialog = new Element('dialog'), grid = add(dialog, 'library-grid');
  const cards = ['one', 'two', 'three'].map(id => {
    const card = add(grid, id); card.className = 'photo-card';
    const button = add(card, undefined, 'button'); button.closest = () => card;
    button.matches = selector => selector === ':focus-visible';
    return { card, button };
  });
  const windowTarget = new Element(), documentTarget = new Element();
  setupLibraryMenus(dialog, grid, { windowTarget, documentTarget });
  return { dialog, cards, windowTarget, documentTarget, shown: () => cards.filter(({ card }) => card.classList.contains('menu-active')).map(({ card }) => card.id) };
}

test('library menus have one owner across touch, keyboard focus and mouse movement', () => {
  const { dialog, cards, shown } = libraryMenus();
  dialog.emit('pointerdown', { pointerType: 'touch', target: cards[0].button });
  assert.deepEqual(shown(), ['one']);
  dialog.emit('focusin', { target: cards[1].button });
  assert.deepEqual(shown(), ['two']);
  dialog.emit('pointermove', { pointerType: 'mouse', target: cards[2].button });
  assert.deepEqual(shown(), ['three']);
  dialog.emit('focusout', { relatedTarget: cards[2].button });
  assert.deepEqual(shown(), ['three']);
  dialog.emit('pointermove', { pointerType: 'mouse', target: dialog });
  assert.deepEqual(shown(), []);
});

test('library menus reset when switching windows, hiding the tab, leaving or closing the library', () => {
  const { dialog, cards, windowTarget, documentTarget, shown } = libraryMenus();
  const activate = () => dialog.emit('pointermove', { pointerType: 'mouse', target: cards[0].button });
  for (const [target, event] of [[windowTarget, 'blur'], [documentTarget, 'visibilitychange'], [dialog, 'pointerleave'], [dialog, 'close']]) {
    activate(); assert.deepEqual(shown(), ['one']);
    target.emit(event, { pointerType: 'mouse' }); assert.deepEqual(shown(), []);
  }
  activate(); cards[0].card.remove();
  dialog.emit('pointerover', { pointerType: 'mouse', target: cards[1].button });
  assert.deepEqual(shown(), ['two']);
});

test('viewer retains the displayed photo until the next is decoded and ignores late navigation results', async t => {
  const dialog = new Element('dialog'), wrap = add(dialog, undefined); wrap.className = 'viewer-image-wrap'; add(wrap, 'viewer-image', 'img');
  for (const id of ['viewer-message', 'viewer-strip', 'viewer-position', 'viewer-previous', 'viewer-next', 'viewer-source', 'viewer-add', 'viewer-favorite', 'viewer-rename', 'viewer-delete', 'viewer-zoom-out', 'viewer-zoom-in', 'viewer-zoom-percent', 'viewer-fit', 'viewer-photo-name', 'viewer-close']) add(dialog, id);
  const images = environment(t, dialog), viewer = createPhotoViewer(dialog);
  const collection = ['a', 'b', 'c'].map(id => ({ id: `local_${id}`, source: 'local', available: true, src: `blob:${id}`, title: id }));
  viewer.open(collection[0], collection); images[0].load(); await flush();
  const first = dialog.querySelector('#viewer-image'); assert.equal(first.src, 'blob:a'); assert.equal(first.decoded, true); assert.equal(first.hidden, false);
  assert.equal(dialog.querySelector('#viewer-source').hidden, true);
  dialog.querySelector('#viewer-next').onclick();
  assert.equal(dialog.querySelector('#viewer-image'), first); assert.equal(first.hidden, false); assert.equal(dialog.querySelector('#viewer-message').hidden, true);
  dialog.querySelector('#viewer-next').onclick();
  images.find(image => image.src === 'blob:b').load(); await flush(); assert.equal(dialog.querySelector('#viewer-image'), first);
  images.find(image => image.src === 'blob:c').load(); await flush(); assert.equal(dialog.querySelector('#viewer-image').src, 'blob:c');
  dialog.querySelector('#viewer-previous').onclick(); await flush();
  assert.equal(dialog.querySelector('#viewer-image').src, 'blob:b'); assert.equal(dialog.querySelector('#viewer-message').hidden, true);
  const shown = dialog.querySelector('#viewer-image');
  viewer.refreshPhoto({ id: 'local_b', title: 'Новое имя.png' });
  assert.equal(dialog.querySelector('#viewer-image'), shown); assert.match(dialog.querySelector('#viewer-photo-name').textContent, /Новое имя.png/);
  assert.equal(dialog.querySelector('#viewer-strip').children[1].title, 'Новое имя.png');
  viewer.remove(['local_b']); await flush();
  assert.equal(dialog.querySelector('#viewer-image').src, 'blob:c'); assert.equal(dialog.querySelector('#viewer-strip').children.length, 2);
  viewer.remove(['local_a', 'local_c']); assert.equal(dialog.open, false); assert.equal(dialog.querySelector('#viewer-image').hidden, true);
});

test('viewer retries failed images and bounds its decoded image cache', async t => {
  const images = environment(t, new Element()), cache = createViewerImageCache({ maximum: 2 });
  const first = cache.load('a'); assert.equal(cache.load('a'), first); images[0].fail(); await assert.rejects(first);
  const retry = cache.load('a'); images[1].load(); assert.equal((await retry).decoded, true);
  const second = cache.load('b'); images[2].load(); await second;
  const third = cache.load('c'); images[3].load(); await third;
  cache.load('a').catch(() => {}); assert.equal(images.length, 5);
  cache.clear();
});

test('viewer touch controls swipe at fit size and pinch without accidentally navigating', async t => {
  const dialog = new Element('dialog'), wrap = add(dialog, undefined); wrap.className = 'viewer-image-wrap'; add(wrap, 'viewer-image', 'img');
  for (const id of ['viewer-message','viewer-strip','viewer-position','viewer-previous','viewer-next','viewer-source','viewer-add','viewer-favorite','viewer-rename','viewer-delete','viewer-zoom-out','viewer-zoom-in','viewer-zoom-percent','viewer-fit','viewer-photo-name','viewer-close']) add(dialog,id);
  const images = environment(t,dialog), viewer = createPhotoViewer(dialog);
  viewer.open({id:'a'},[{id:'a',title:'a',available:true,src:'blob:a'},{id:'b',title:'b',available:true,src:'blob:b'}]);
  images[0].load(); await flush();
  const touch = (id,x,y=200) => ({pointerId:id,pointerType:'touch',isPrimary:id===1,button:0,clientX:x,clientY:y,target:{closest:()=>false},preventDefault(){}});
  wrap.onpointerdown(touch(1,800)); wrap.onpointermove(touch(1,500)); wrap.onpointerup(touch(1,500));
  images.find(image=>image.src==='blob:b').load(); await flush(); assert.equal(dialog.querySelector('#viewer-image').src,'blob:b');
  wrap.onpointerdown(touch(1,300)); wrap.onpointerdown(touch(2,700)); wrap.onpointermove(touch(2,1100));
  assert.match(dialog.querySelector('#viewer-image').style.transform,/scale\(2\)/);
  wrap.onpointerup(touch(2,1100)); assert.equal(dialog.querySelector('#viewer-image').src,'blob:b');
  dialog.close();
});

test('admin policy changes retain row elements, control state and a clearly selected key type', async t => {
  const root = new Element(), dialog = add(root, 'admin-dialog', 'dialog');
  for (const id of ['admin-audit', 'admin-error', 'admin-all-access', 'admin-open-registration', 'admin-users', 'admin-keys', 'admin-keys-empty', 'key-type-menu', 'key-type-trigger', 'key-type-value', 'key-hours-field', 'key-hours', 'admin-key-form', 'key-label', 'created-key', 'created-key-box', 'copy-created-key', 'admin-close', 'admin-encryption', 'rotate-token-key', 'token-key-status']) add(dialog, id);
  const menu = dialog.querySelector('#key-type-menu');
  for (const type of ['single', 'temporary', 'permanent']) { const button = new Element('button'); button.dataset.keyType = type; menu.append(button); }
  environment(t, root);
  let data = { policies: { grantAllRegistered: true, openRegistration: true }, users: [{ id: 'owner', login: 'owner', isGlobalAdmin: true, isAdmin: true, hasFullAccess: true }, { id: 'reader', login: 'reader', isGlobalAdmin: false, isAdmin: false, hasFullAccess: true }], keys: [] };
  let release; const calls = [], panel = setupAdmin({ currentUser: () => data.users[0], confirm: async () => true, request: async (path, input) => {
    calls.push({ path, input }); if (path === 'admin/policy') { await new Promise(resolve => { release = resolve; }); data = { ...data, policies: { ...data.policies, ...input }, users: data.users.map(user => ({ ...user, hasFullAccess: user.isAdmin })) }; } return data;
  } });
  await panel.open();
  const rows = dialog.querySelector('#admin-users'), row = rows.children[1], checkbox = row.children[2].children[0], remove = row.children[4].children.at(-1);
  assert.equal(checkbox.disabled, true); assert.equal(remove.disabled, false);
  const allAccess = dialog.querySelector('#admin-all-access'); allAccess.checked = false; allAccess.onchange({ target: allAccess });
  assert.equal(dialog.dataset.busy, 'true'); assert.equal(rows.children[1], row); assert.equal(remove.disabled, false);
  release(); await flush(); assert.equal(rows.children[1], row); assert.equal(row.children[2].children[0], checkbox); assert.equal(checkbox.disabled, false); assert.equal(checkbox.checked, false);
  menu.children[1].onclick(); assert.equal(dialog.querySelector('#key-type-value').textContent, 'Временный'); assert.equal(menu.children[1].getAttribute('aria-selected'), 'true'); assert.equal(menu.children[0].getAttribute('aria-selected'), 'false');
  const duration = dialog.querySelector('#key-hours-field'), hours = dialog.querySelector('#key-hours');
  assert.equal(duration.hidden, false); assert.equal(duration.inert, false); assert.equal(hours.disabled, false);
  menu.children[0].onclick();
  assert.equal(duration.hidden, false); assert.equal(duration.dataset.inactive, 'true'); assert.equal(duration.inert, true); assert.equal(hours.disabled, true);
  menu.children[1].onclick();
  assert.equal(duration.hidden, false); assert.equal(duration.dataset.inactive, 'false'); assert.equal(hours.disabled, false);
  dialog.querySelector('#key-hours').value = '12'; dialog.querySelector('#admin-key-form').onsubmit({ preventDefault() {}, currentTarget: dialog.querySelector('#admin-key-form') }); await flush();
  assert.deepEqual(calls.at(-1).input, { type: 'temporary', hours: 12, label: '' });
  assert.equal(rows.children[1], row);
  assert.equal(dialog.querySelector('#admin-encryption').hidden, false);
  await dialog.querySelector('#rotate-token-key').onclick();
  assert.equal(calls.at(-1).path, 'admin/token-key/rotate'); assert.deepEqual(calls.at(-1).input, { confirmed: true });
  const count = calls.length; data.users[0].isGlobalAdmin = false;
  await dialog.querySelector('#rotate-token-key').onclick(); assert.equal(calls.length, count);
});

test('the RGB 227 canvas default replaces previous defaults in saved and demo settings', () => {
  assert.equal(defaults.background, '#e3e3e3'); assert.equal(validateSettings({}).background, '#e3e3e3');
  assert.equal(validateSettings({ background: '#f0eadf' }).background, '#e3e3e3');
  assert.equal(validateSettings({ background: '#F0EADF' }).background, '#e3e3e3');
  assert.equal(validateSettings({ background: '#e3e1de' }).background, '#e3e3e3');
  assert.equal(validateSettings({ background: '#abcdef' }).background, '#abcdef');
});
