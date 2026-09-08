const cepInput = document.querySelector('[name="cep"]');
const telefoneInput = document.querySelector('[name="telefone"]');
const emailInput = document.querySelector('[name="email"]');
const senhaInput = document.querySelector('[name="senha"]');
const cidadeInput = document.querySelector('[name="cidade"]');
const estadoInput = document.querySelector('[name="estado"]');
const enderecoInput = document.querySelector('[name="endereco"]');
const cepStatus = document.querySelector('#cep-status');
const emailStatus = document.querySelector('#email-status');
const senhaStatus = document.querySelector('#senha-status');

let currentRequest;
let lastSuccessfulCep = '';
let emailWasValidated = false;

function setStatus(message, isError = false) {
  cepStatus.textContent = message;
  cepStatus.classList.toggle('error', isError);
}

function formatCep(value) {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

function formatTelefone(value) {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits ? `(${digits}` : '';

  const prefix = `(${digits.slice(0, 2)}) `;
  if (digits.length <= 6) return prefix + digits.slice(2);

  const separatorIndex = digits.length === 11 ? 7 : 6;
  return `${prefix}${digits.slice(2, separatorIndex)}-${digits.slice(separatorIndex)}`;
}

function validateEmail(showMessage) {
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value.trim());
  const message = 'Informe um e-mail válido, como usuario@dominio.com.';

  emailInput.setCustomValidity(isValid ? '' : message);
  emailStatus.textContent = showMessage && !isValid ? message : '';
  emailStatus.classList.toggle('error', showMessage && !isValid);
  return isValid;
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error('Serviço de CEP indisponível.');
  }
  return response.json();
}

async function consultViaCep(cep, signal) {
  const data = await fetchJson(`https://viacep.com.br/ws/${cep}/json/`, signal);
  if (data.erro) {
    throw new Error('CEP não encontrado.');
  }
  return { endereco: data.logradouro, cidade: data.localidade, estado: data.uf };
}

async function consultBrasilApi(cep, signal) {
  const data = await fetchJson(`https://brasilapi.com.br/api/cep/v1/${cep}`, signal);
  return { endereco: data.street, cidade: data.city, estado: data.state };
}

async function findAddress(cep) {
  currentRequest?.abort();
  currentRequest = new AbortController();

  setStatus('Consultando CEP...');
  cepInput.setAttribute('aria-busy', 'true');

  try {
    let address;
    try {
      address = await consultViaCep(cep, currentRequest.signal);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      address = await consultBrasilApi(cep, currentRequest.signal);
    }

    enderecoInput.value = address.endereco || '';
    cidadeInput.value = address.cidade || '';
    estadoInput.value = address.estado || '';
    lastSuccessfulCep = cep;
    setStatus('Endereço encontrado.');
  } catch (error) {
    if (error.name !== 'AbortError') {
      lastSuccessfulCep = '';
      setStatus('Não foi possível localizar o CEP. Preencha o endereço manualmente.', true);
    }
  } finally {
    cepInput.removeAttribute('aria-busy');
  }
}

cepInput.addEventListener('input', () => {
  cepInput.value = formatCep(cepInput.value);
  const cep = cepInput.value.replace(/\D/g, '');

  if (cep.length < 8) {
    currentRequest?.abort();
    lastSuccessfulCep = '';
    setStatus('');
    return;
  }

  if (cep !== lastSuccessfulCep) {
    findAddress(cep);
  }
});

telefoneInput.addEventListener('input', () => {
  telefoneInput.value = formatTelefone(telefoneInput.value);
});

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