export function setupAccountEditor({ request, onSelfChange }) {
  const dialog = document.querySelector('#account-edit-dialog'), form = document.querySelector('#account-edit-form');
  const error = document.querySelector('#account-edit-error');
  let target, kind, self, busy = false, resolveOpen;
  const fields = form.elements;
  function finish(value) { const resolve = resolveOpen; resolveOpen = null; resolve?.(value); }
  dialog.addEventListener('close', () => { form.reset(); finish(null); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  document.querySelector('#account-edit-cancel').onclick = () => { if (!busy) dialog.close(); };
  form.onsubmit = async event => {
    event.preventDefault(); if (busy) return; error.hidden = true;
    try {
      if (self && !fields.oldPassword.value) throw new Error('Введите текущий пароль');
      if (kind === 'password' && (fields.newPassword.value.length < 8 || fields.newPassword.value.length > 128)) throw new Error('Пароль должен содержать от 8 до 128 символов');
      if (kind === 'password' && fields.newPassword.value !== fields.confirmPassword.value) throw new Error('Пароли не совпадают');
      if (kind === 'login' && !/^[a-z0-9_.-]{3,32}$/i.test(fields.login.value.trim())) throw new Error('Логин: от 3 до 32 латинских букв, цифр, точек, дефисов или подчёркиваний');
      busy = true; dialog.dataset.busy = 'true'; for (const field of fields) field.disabled = true;
      const result = await request(self ? 'auth/change' : 'admin/users/credentials', { id: target.id, kind, ...(self ? { oldPassword: fields.oldPassword.value } : {}), ...(kind === 'login' ? { login: fields.login.value } : { newPassword: fields.newPassword.value }) });
      if (self) onSelfChange(result.user);
      finish(result); dialog.close();
    } catch (failure) { error.textContent = failure.message; error.hidden = false; }
    finally { busy = false; delete dialog.dataset.busy; for (const field of fields) field.disabled = false; }
  };
  return {
    open(user, operation, own = false) {
      if (dialog.open) return Promise.resolve(null);
      target = user; kind = operation; self = own; form.reset(); error.hidden = true;
      document.querySelector('#account-edit-title').textContent = (kind === 'login' ? 'Сменить логин' : 'Сменить пароль') + (self ? '' : ` · ${user.login} (#${user.id})`);
      for (const label of form.querySelectorAll('[data-account-field]')) label.hidden = label.dataset.accountField === 'old' ? !self : label.dataset.accountField !== kind;
      fields.login.value = kind === 'login' ? user.login : '';
      dialog.showModal(); (self ? fields.oldPassword : kind === 'login' ? fields.login : fields.newPassword).focus();
      return new Promise(resolve => { resolveOpen = resolve; });
    },
  };
}
