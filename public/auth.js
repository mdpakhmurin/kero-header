export function setupAuth({ request, enter }) {
  const form = document.querySelector('#auth-form'), error = document.querySelector('#auth-error');
  let registering = false, busy = false;
  function choose(next) {
    registering = next; error.hidden = true;
    document.querySelector('#auth-title').textContent = registering ? 'Создать аккаунт' : 'С возвращением';
    form.elements.password.autocomplete = registering ? 'new-password' : 'current-password';
    form.elements.password.minLength = registering ? 12 : 1;
    form.elements.confirmPassword.required = registering;
    form.elements.confirmPassword.disabled = !registering;
    document.querySelector('#auth-confirm-field').hidden = !registering;
    document.querySelector('#auth-password-hint').hidden = !registering;
    document.querySelector('#auth-submit').textContent = registering ? 'Зарегистрироваться' : 'Войти';
    document.querySelectorAll('[data-auth-tab]').forEach(button => button.setAttribute('aria-pressed', String((button.dataset.authTab === 'register') === registering)));
  }
  document.querySelectorAll('[data-auth-tab]').forEach(button => button.onclick = () => { if (!busy) choose(button.dataset.authTab === 'register'); });
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    error.hidden = true;
    if (registering && form.elements.password.value !== form.elements.confirmPassword.value) { error.textContent = 'Пароли не совпадают'; error.hidden = false; return; }
    busy = true;
    document.querySelector('#auth-demo').disabled = true;
    const submit = document.querySelector('#auth-submit'); submit.disabled = true; submit.textContent = registering ? 'Создаём аккаунт…' : 'Входим…';
    try {
      await request(registering ? 'auth/register' : 'auth/login', { login: form.elements.login.value, password: form.elements.password.value });
      form.elements.password.value = form.elements.confirmPassword.value = ''; enter();
    } catch (failure) { error.textContent = failure.message; error.hidden = false; }
    finally { busy = false; submit.disabled = false; document.querySelector('#auth-demo').disabled = false; submit.textContent = registering ? 'Зарегистрироваться' : 'Войти'; }
  };
  choose(false);
}
