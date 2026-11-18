export function displayUsername(login) { return login.charAt(0).toLocaleUpperCase('ru-RU') + login.slice(1); }

export function setupAuth({ request, enter }) {
  const form = document.querySelector('#auth-form'), error = document.querySelector('#auth-error');
  let registering = false, busy = false, openRegistration = true;
  const names = ['login', 'password', 'confirmPassword', 'registrationKey'];
  form.noValidate = true;
  function fieldError(name, message = '') {
    const input = form.elements[name], hint = document.querySelector(`#auth-${name}-error`);
    input.setAttribute('aria-invalid', String(Boolean(message)));
    input.setAttribute('aria-describedby', hint.id);
    hint.setAttribute('aria-live', 'polite');
    hint.textContent = message; hint.hidden = !message;
  }
  function clearErrors() { error.hidden = true; names.forEach(name => fieldError(name)); }
  function validate() {
    clearErrors(); const fields = form.elements, failures = [];
    const fail = (name, message) => { fieldError(name, message); failures.push(fields[name]); };
    if (!fields.login.value.trim()) fail('login', 'Введите логин');
    else if (!/^[a-z0-9_.-]{3,32}$/i.test(fields.login.value.trim())) fail('login', 'От 3 до 32 латинских букв, цифр, точек, дефисов или подчёркиваний');
    const password = fields.password.value;
    if (!password) fail('password', 'Введите пароль');
    else if (password.length > 128 || registering && password.length < 8) fail('password', 'Пароль должен содержать от 8 до 128 символов');
    if (registering && !fields.confirmPassword.value) fail('confirmPassword', 'Повторите пароль');
    else if (registering && password !== fields.confirmPassword.value) fail('confirmPassword', 'Пароли не совпадают');
    if (registering && !openRegistration && !fields.registrationKey.value.trim()) fail('registrationKey', 'Введите ключ регистрации');
    failures[0]?.focus(); return !failures.length;
  }
  form.addEventListener('input', event => { if (names.includes(event.target.name)) fieldError(event.target.name); error.hidden = true; });
  function updateKeyField() {
    const required = registering && !openRegistration;
    document.querySelector('#auth-key-field').hidden = !required;
    form.elements.registrationKey.disabled = !required; form.elements.registrationKey.required = required;
  }
  function choose(next) {
    registering = next; clearErrors();
    document.querySelector('#auth-title').textContent = registering ? 'Создать аккаунт' : 'С возвращением';
    form.elements.password.autocomplete = registering ? 'new-password' : 'current-password';
    form.elements.password.minLength = registering ? 8 : 1;
    form.elements.confirmPassword.required = registering;
    form.elements.confirmPassword.disabled = !registering;
    document.querySelector('#auth-confirm-field').hidden = !registering;
    document.querySelector('#auth-password-hint').hidden = !registering;
    document.querySelector('#auth-submit').textContent = registering ? 'Зарегистрироваться' : 'Войти';
    document.querySelectorAll('[data-auth-tab]').forEach(button => button.setAttribute('aria-pressed', String((button.dataset.authTab === 'register') === registering)));
    updateKeyField();
  }
  document.querySelectorAll('[data-auth-tab]').forEach(button => button.onclick = () => { if (!busy) choose(button.dataset.authTab === 'register'); });
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || !validate()) return;
    busy = true;
    document.querySelector('#auth-demo').disabled = true;
    const submit = document.querySelector('#auth-submit'); submit.disabled = true; submit.textContent = registering ? 'Создаём аккаунт…' : 'Входим…';
    try {
      await request(registering ? 'auth/register' : 'auth/login', { login: form.elements.login.value, password: form.elements.password.value, ...(registering && !openRegistration ? { registrationKey: form.elements.registrationKey.value } : {}) });
      form.elements.password.value = form.elements.confirmPassword.value = ''; enter();
    } catch (failure) {
      if (failure.code === 'REGISTRATION_KEY_REQUIRED') { openRegistration = false; updateKeyField(); fieldError('registrationKey', failure.message); form.elements.registrationKey.focus(); }
      else if (registering && failure.status === 409) { fieldError('login', failure.message); form.elements.login.focus(); }
      else { error.textContent = failure.message; error.hidden = false; }
    }
    finally { busy = false; submit.disabled = false; document.querySelector('#auth-demo').disabled = false; submit.textContent = registering ? 'Зарегистрироваться' : 'Войти'; }
  };
  choose(false);
  return { setPolicy(policy) { openRegistration = policy.openRegistration; updateKeyField(); } };
}
