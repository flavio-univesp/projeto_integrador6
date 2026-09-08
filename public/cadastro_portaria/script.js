const emailInput = document.querySelector('[name="email"]');
const senhaInput = document.querySelector('[name="senha"]');
const turnoInput = document.querySelector('[name="turno"]');
const emailStatus = document.querySelector('#email-status');
const senhaStatus = document.querySelector('#senha-status');
const turnoStatus = document.querySelector('#turno-status');

let emailWasValidated = false;

function validateEmail(showMessage) {
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value.trim());
  const message = 'Informe um e-mail válido, como usuario@dominio.com.';

  emailInput.setCustomValidity(isValid ? '' : message);
  emailStatus.textContent = showMessage && !isValid ? message : '';
  emailStatus.classList.toggle('error', showMessage && !isValid);
  return isValid;
}

emailInput.addEventListener('blur', () => {
  emailWasValidated = true;
  validateEmail(true);
});

emailInput.addEventListener('input', () => {
  validateEmail(emailWasValidated);
});

emailInput.addEventListener('invalid', () => {
  emailWasValidated = true;
  validateEmail(true);
});

senhaInput.addEventListener('invalid', (event) => {
  event.preventDefault();
  const message = 'Campo obrigatório de preenchimento';
  senhaStatus.textContent = message;
  senhaStatus.classList.add('error');
  senhaInput.focus();
});

senhaInput.addEventListener('input', () => {
  senhaStatus.textContent = '';
  senhaStatus.classList.remove('error');
});

turnoInput.addEventListener('invalid', (event) => {
  event.preventDefault();
  turnoStatus.textContent = 'Obrigatorio a seleção do turno';
  turnoStatus.classList.add('error');
  turnoInput.setAttribute('aria-invalid', 'true');
  turnoInput.focus();
});

turnoInput.addEventListener('change', () => {
  if (turnoInput.value) {
    turnoStatus.textContent = '';
    turnoStatus.classList.remove('error');
    turnoInput.removeAttribute('aria-invalid');
  }
});