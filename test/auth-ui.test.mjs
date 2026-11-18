import test from 'node:test';
import assert from 'node:assert/strict';
import { setupAuth } from '../public/auth.js';

function fixture(t, request) {
  let focused;
  const field = value => ({ value, disabled: false, required: false, setAttribute(name, value) { this[name] = value; }, focus() { focused = this; } });
  const elements = { login: field('test_user'), password: field('test1234'), confirmPassword: field('test1234'), registrationKey: field('kr_test_key') };
  const tabs = ['login', 'register'].map(value => ({ dataset: { authTab: value }, setAttribute() {} }));
  const listeners = {};
  const form = { elements, reportValidity() { throw Error('Native validation must not be used'); }, addEventListener(name, listener) { listeners[name] = listener; } }, nodes = new Map([['#auth-form', form]]);
  const old = globalThis.document; let entered = 0;
  globalThis.document = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, { id: selector.slice(1), setAttribute() {} }); return nodes.get(selector); }, querySelectorAll: () => tabs };
  t.after(() => { globalThis.document = old; });
  const ui = setupAuth({ request, enter: () => { entered++; } });
  return { ui, tabs, form, nodes, listeners, focused: () => focused, entered: () => entered };
}

test('closed registration requires the invitation field, while login remains available without a key', async t => {
  const calls = [], f = fixture(t, async (path, input) => { calls.push({ path, input }); });
  f.ui.setPolicy({ openRegistration: false });
  assert.equal(f.nodes.get('#auth-key-field').hidden, true); assert.equal(f.form.elements.registrationKey.disabled, true);
  f.tabs[1].onclick(); assert.equal(f.nodes.get('#auth-key-field').hidden, false); assert.equal(f.form.elements.registrationKey.required, true);
  await f.form.onsubmit({ preventDefault() {} }); assert.equal(calls[0].input.registrationKey, 'kr_test_key'); assert.equal(f.entered(), 1);
  f.tabs[0].onclick(); f.form.elements.password.value = 'test1234';
  assert.equal(f.form.elements.registrationKey.required, false); assert.equal(f.form.elements.registrationKey.disabled, true);
  await f.form.onsubmit({ preventDefault() {} }); assert.equal(calls[1].path, 'auth/login'); assert.equal(Object.hasOwn(calls[1].input, 'registrationKey'), false);
});

test('registration reacts when an administrator closes registration after the form was opened', async t => {
  const f = fixture(t, async () => { throw Object.assign(Error('Нужен ключ'), { code: 'REGISTRATION_KEY_REQUIRED' }); });
  f.tabs[1].onclick(); assert.equal(f.nodes.get('#auth-key-field').hidden, true);
  await f.form.onsubmit({ preventDefault() {} });
  assert.equal(f.nodes.get('#auth-key-field').hidden, false); assert.equal(f.form.elements.registrationKey.required, true);
  assert.equal(f.nodes.get('#auth-registrationKey-error').textContent, 'Нужен ключ'); assert.equal(f.entered(), 0);
});

test('auth shows inline validation, focuses the first invalid input and clears errors while typing', async t => {
  let requests = 0; const f = fixture(t, async () => { requests++; }); f.tabs[1].onclick();
  f.form.elements.login.value = 'два'; f.form.elements.password.value = 'short'; f.form.elements.confirmPassword.value = 'different';
  await f.form.onsubmit({ preventDefault() {} });
  assert.equal(requests, 0); assert.equal(f.form.noValidate, true); assert.equal(f.focused(), f.form.elements.login);
  for (const name of ['login', 'password', 'confirmPassword']) { assert.equal(f.form.elements[name]['aria-invalid'], 'true'); assert.equal(f.nodes.get(`#auth-${name}-error`).hidden, false); }
  f.form.elements.login.value = 'valid_user'; f.listeners.input({ target: { name: 'login' } });
  assert.equal(f.nodes.get('#auth-login-error').hidden, true); assert.equal(f.form.elements.login['aria-invalid'], 'false');
  f.form.elements.password.value = f.form.elements.confirmPassword.value = 'valid_password';
  await f.form.onsubmit({ preventDefault() {} }); assert.equal(requests, 1); assert.equal(f.entered(), 1);
});

test('closed registration validates an empty key inline and never sends an invalid form', async t => {
  let requests = 0; const f = fixture(t, async () => { requests++; }); f.ui.setPolicy({ openRegistration: false }); f.tabs[1].onclick();
  f.form.elements.registrationKey.value = '  '; await f.form.onsubmit({ preventDefault() {} });
  assert.equal(requests, 0); assert.equal(f.focused(), f.form.elements.registrationKey);
  assert.equal(f.nodes.get('#auth-registrationKey-error').textContent, 'Введите ключ регистрации');
});
