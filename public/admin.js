import { displayUsername } from './auth.js';

export function setupAdmin({ request, confirm, currentUser, editAccount }) {
  const dialog = document.querySelector('#admin-dialog'), error = document.querySelector('#admin-error');
  const $ = selector => dialog.querySelector(selector);
  const users = new Map(), keys = new Map();
  let data, busy = false, keyType = 'single';
  const text = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
  function setBusy(value) { busy = value; dialog.dataset.busy = String(value); dialog.setAttribute('aria-busy', String(value)); }
  // Keep controls and focus in place while a request is pending.
  dialog.addEventListener('click', event => { if (busy) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  dialog.addEventListener('keydown', event => { if (busy && event.key !== 'Tab' && event.key !== 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  dialog.addEventListener('beforeinput', event => { if (busy) event.preventDefault(); }, true);
  async function mutate(path, input) {
    if (busy) return; setBusy(true); error.hidden = true;
    try {
      const { code, ...snapshot } = await request(path, input); data = snapshot;
      if (code) { $('#created-key').value = code; $('#created-key-box').hidden = false; $('#copy-created-key').textContent = 'Скопировать'; }
      if (data.tokenKeyRotation) { $('#token-key-status').textContent = 'Новый ключ сохранён. Все токены VK перешифрованы.'; $('#token-key-status').hidden = false; }
    } catch (failure) { error.textContent = failure.message; error.hidden = false; }
    finally { setBusy(false); if (data) render(); }
  }
  function checkbox(change) { const input = document.createElement('input'); input.type = 'checkbox'; input.onchange = () => { if (busy) render(); else change(input.checked); }; return input; }
  function reconcile(parent, cache, models, create, update) {
    const ids = new Set(models.map(model => model.id));
    for (const [id, row] of cache) if (!ids.has(id)) { row.element.remove(); cache.delete(id); }
    models.forEach((model, index) => {
      let row = cache.get(model.id); if (!row) { row = create(model); cache.set(model.id, row); }
      update(row, model);
      if (parent.children[index] !== row.element) parent.insertBefore(row.element, parent.children[index] || null);
    });
  }
  function createUserRow(user) {
    const element = document.createElement('tr'), nameCell = document.createElement('td');
    const name = text('strong', ''), badge = text('span', 'Глобальный администратор', 'admin-role-label'); nameCell.append(name, badge);
    const accessCell = document.createElement('td'), roleCell = document.createElement('td'), actions = document.createElement('td');
    const access = checkbox(fullAccess => mutate('admin/users/update', { id: user.id, fullAccess }));
    const role = checkbox(admin => mutate('admin/users/update', { id: user.id, admin }));
    accessCell.append(access); roleCell.append(role);
    const remove = text('button', 'Удалить', 'admin-delete-user'); remove.type = 'button';
    remove.onclick = async () => {
      if (busy || !await confirm({ title: 'Удалить пользователя «' + displayUsername(user.login) + '»?', description: 'Его аккаунт, личные настройки и библиотека будут удалены.', label: 'Удалить пользователя' })) return;
      await mutate('admin/users/delete', { id: user.id });
    };
    const editButtons = ['login', 'password'].map(kind => {
      const button = text('button', kind === 'login' ? 'Логин' : 'Пароль', 'button light small'); button.type = 'button';
      button.onclick = async () => {
        if (busy) return; setBusy(true);
        try { const next = await editAccount(data.users.find(saved => saved.id === user.id), kind); if (next) data = next; }
        finally { setBusy(false); render(); }
      };
      actions.append(button); return button;
    });
    actions.className = 'admin-user-actions'; actions.append(remove); element.append(nameCell, text('td', user.id, 'admin-user-id'), accessCell, roleCell, actions);
    return { element, name, badge, access, role, remove, editButtons };
  }
  function updateUserRow(row, user) {
    const login = displayUsername(user.login); row.name.textContent = login; row.badge.hidden = !user.isGlobalAdmin;
    row.access.checked = user.hasFullAccess; row.access.disabled = data.policies.grantAllRegistered || user.isAdmin;
    row.access.setAttribute('aria-label', 'Полный доступ: ' + login);
    row.role.checked = user.isAdmin; row.role.disabled = !currentUser().isGlobalAdmin || user.isGlobalAdmin;
    row.role.setAttribute('aria-label', 'Администратор: ' + login);
    row.remove.disabled = user.id === currentUser().id || user.isGlobalAdmin || user.isAdmin && !currentUser().isGlobalAdmin;
    row.remove.setAttribute('aria-label', 'Удалить пользователя ' + login);
    for (const button of row.editButtons) button.disabled = user.id === currentUser().id || !currentUser().isGlobalAdmin && user.isAdmin;
  }
  const types = { single: 'Одноразовый', temporary: 'Временный', permanent: 'Постоянный' };
  function createKeyRow(key) {
    const element = document.createElement('div'); element.className = 'admin-key-row';
    const info = document.createElement('div'), name = text('strong', ''), code = text('code', ''), status = text('span', '', 'admin-key-status'); info.append(name, code, status);
    const revoke = text('button', 'Отозвать', 'button light small'); revoke.type = 'button';
    revoke.onclick = async () => { if (!busy && await confirm({ title: 'Отозвать ключ?', description: 'Использовать этот ключ для новых регистраций больше не получится.', label: 'Отозвать' })) await mutate('admin/keys/revoke', { id: key.id }); };
    element.append(info, revoke); return { element, name, code, status, revoke };
  }
  function updateKeyRow(row, key) {
    row.name.textContent = key.label || types[key.type]; row.code.textContent = key.mask;
    const status = !key.active ? key.revoked ? 'Отозван' : key.expiresAt && key.expiresAt <= Date.now() ? 'Истёк' : 'Использован' : key.expiresAt ? 'До ' + new Date(key.expiresAt).toLocaleString('ru-RU') : key.type === 'single' ? 'Одна регистрация' : 'Без срока';
    row.status.textContent = types[key.type] + ' · ' + status + ' · Регистраций: ' + key.uses; row.revoke.disabled = !key.active;
  }
  function render() {
    $('#admin-encryption').hidden = !currentUser().isGlobalAdmin;
    $('#admin-all-access').checked = data.policies.grantAllRegistered; $('#admin-open-registration').checked = data.policies.openRegistration;
    reconcile($('#admin-users'), users, data.users, createUserRow, updateUserRow);
    reconcile($('#admin-keys'), keys, [...data.keys].reverse(), createKeyRow, updateKeyRow);
    $('#admin-keys-empty').hidden = data.keys.length > 0;
    const audit = $('#admin-audit'); audit.replaceChildren();
    for (const event of data.audit || []) {
      const row = text('div', '', 'audit-row');
      row.append(text('time', new Date(event.createdAt).toLocaleString('ru-RU')), text('span', `${event.actorLogin} (#${event.actorId}) → ${event.targetLogin} (#${event.targetId})`), text('span', event.kind === 'password' ? 'Смена пароля' : `Логин: ${event.oldLogin} → ${event.newLogin}`)); audit.append(row);
    }
    if (!audit.children.length) audit.append(text('p', 'Изменений пока нет.', 'admin-note'));
  }
  $('#admin-all-access').onchange = event => { if (busy) render(); else mutate('admin/policy', { grantAllRegistered: event.target.checked }); };
  $('#admin-open-registration').onchange = event => { if (busy) render(); else mutate('admin/policy', { openRegistration: event.target.checked }); };
  $('#rotate-token-key').onclick = async () => {
    if (busy || !currentUser().isGlobalAdmin) return;
    if (!await confirm({ title: 'Создать новый ключ шифрования?', description: 'Все сохранённые токены VK будут перешифрованы новым ключом. Подключения пользователей сохранятся.', label: 'Создать ключ', danger: false })) return;
    await mutate('admin/token-key/rotate', { confirmed: true });
  };
  const menu = $('#key-type-menu'), trigger = $('#key-type-trigger'), choices = [...menu.querySelectorAll('[data-key-type]')];
  function positionMenu() {
    const rect = trigger.getBoundingClientRect(); menu.style.width = rect.width + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, rect.bottom + menu.offsetHeight + 8 <= innerHeight ? rect.bottom + 6 : rect.top - menu.offsetHeight - 6) + 'px';
  }
  menu.addEventListener('toggle', event => { trigger.setAttribute('aria-expanded', String(event.newState === 'open')); if (event.newState === 'open') positionMenu(); });
  for (const button of choices) button.onclick = () => {
    if (busy) return; keyType = button.dataset.keyType;
    choices.forEach(choice => choice.setAttribute('aria-selected', String(choice === button))); $('#key-type-value').textContent = types[keyType];
    const temporary = keyType === 'temporary';
    $('#key-hours-field').dataset.inactive = String(!temporary); $('#key-hours-field').inert = !temporary;
    $('#key-hours-field').setAttribute('aria-hidden', String(!temporary));
    $('#key-hours').required = temporary; $('#key-hours').disabled = !temporary;
    menu.hidePopover(); trigger.focus({ preventScroll: true });
  };
  trigger.onkeydown = event => { if (!busy && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); menu.showPopover(); positionMenu(); choices.find(button => button.dataset.keyType === keyType).focus(); } };
  menu.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.hidePopover(); trigger.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const index = choices.indexOf(document.activeElement);
    choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length].focus();
  };
  dialog.addEventListener('scroll', event => { if (!menu.contains(event.target)) menu.hidePopover(); }, true);
  window.addEventListener('resize', () => menu.hidePopover());
  $('#admin-key-form').onsubmit = event => {
    event.preventDefault(); if (busy || !event.currentTarget.reportValidity()) return;
    menu.hidePopover(); mutate('admin/keys/create', { type: keyType, hours: Number($('#key-hours').value), label: $('#key-label').value });
  };
  $('#copy-created-key').onclick = async () => {
    try { await navigator.clipboard.writeText($('#created-key').value); $('#copy-created-key').textContent = 'Скопировано'; }
    catch { $('#created-key').focus(); $('#created-key').select(); }
  };
  $('#admin-close').onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { menu.hidePopover(); $('#created-key').value = ''; $('#created-key-box').hidden = true; $('#copy-created-key').textContent = 'Скопировать'; $('#token-key-status').hidden = true; });
  return {
    async open() {
      if (dialog.open) return; error.hidden = true; dialog.showModal(); setBusy(true);
      try { data = await request('admin/state'); render(); }
      catch (failure) { error.textContent = failure.message; error.hidden = false; }
      finally { setBusy(false); }
    },
  };
}
