import express from 'express';
import session from 'express-session';
import ejs from 'ejs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, timingSafeEqual } from 'crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobClient, BlockBlobClient } from '@azure/storage-blob';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET deve ser configurado em produção.');
}

const sessionSecret = process.env.SESSION_SECRET || randomUUID();
const azureCredential = new DefaultAzureCredential();
const maxAccessLogBytes = 1024 * 1024;
const maxAccessLogEntries = 5000;
const residentsBlobName = 'tags-autorizadas.json';
let residentsSnapshotQueue = Promise.resolve();

app.engine('ejs', ejs.renderFile);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'strict'
  }
}));

const dbSslRequired = process.env.DB_SSL === 'true'
  || process.env.DB_SSL_MODE?.toUpperCase() === 'REQUIRED';

const dbConfig = {
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'condoservicos',
  password: process.env.DB_PASSWORD || 'condoservicos123',
  database: process.env.DB_NAME || 'condoservicos',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: dbSslRequired ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined
};

const pool = mysql.createPool(dbConfig);

function webhookSecretsMatch(receivedSecret, configuredSecret) {
  if (!receivedSecret || !configuredSecret) {
    return false;
  }

  const received = Buffer.from(receivedSecret);
  const configured = Buffer.from(configuredSecret);
  return received.length === configured.length && timingSafeEqual(received, configured);
}

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function publishResidentsSnapshot() {
  const publish = async () => {
    const storageAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const containerName = process.env.RESIDENTS_BLOB_CONTAINER_NAME;

    if (!storageAccountName || !containerName) {
      if (isProduction) {
        throw new Error('Configuração do container de residentes indisponível.');
      }
      return;
    }

    const [residents] = await pool.execute(
      `SELECT TAGID AS tagid
       FROM moradores
       WHERE TAGID IS NOT NULL AND TRIM(TAGID) <> ''
       ORDER BY TAGID`
    );
    const generatedAt = new Date().toISOString();
    const snapshot = {
      version: generatedAt,
      generatedAt,
      tags: residents.map(({ tagid }) => ({ tagid }))
    };
    const content = JSON.stringify(snapshot, null, 2);
    const blobUrl = `https://${storageAccountName}.blob.core.windows.net/${containerName}/${residentsBlobName}`;
    const blobClient = new BlockBlobClient(blobUrl, azureCredential);

    await blobClient.uploadData(Buffer.from(content, 'utf8'), {
      blobHTTPHeaders: {
        blobContentType: 'application/json; charset=utf-8',
        blobCacheControl: 'no-cache'
      }
    });
    console.log(`Lista de TAGs publicada em ${containerName}/${residentsBlobName}.`);
  };

  const operation = residentsSnapshotQueue.then(publish);
  residentsSnapshotQueue = operation.catch(() => {});
  return operation;
}

async function downloadAccessLog(blobUrl) {
  const storageAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const containerName = process.env.ACCESS_LOGS_BLOB_CONTAINER_NAME;

  if (!storageAccountName || !containerName) {
    throw createHttpError('Configuração do Blob Storage indisponível.', 503);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(blobUrl);
  } catch {
    throw createHttpError('URL do blob inválida.', 400);
  }

  const expectedHost = `${storageAccountName}.blob.core.windows.net`;
  const pathParts = parsedUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== expectedHost
      || pathParts[0] !== containerName || pathParts[1] !== 'logs'
      || !pathParts[2] || !parsedUrl.pathname.toLowerCase().endsWith('.ndjson')) {
    throw createHttpError('Blob fora do caminho de ingestão permitido.', 400);
  }

  const response = await new BlobClient(parsedUrl.toString(), azureCredential).download();
  if (response.contentLength > maxAccessLogBytes || !response.readableStreamBody) {
    throw createHttpError('Arquivo de acesso ausente ou maior que o permitido.', 413);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.readableStreamBody) {
    totalBytes += chunk.length;
    if (totalBytes > maxAccessLogBytes) {
      throw createHttpError('Arquivo de acesso maior que o permitido.', 413);
    }
    chunks.push(Buffer.from(chunk));
  }

  return {
    content: Buffer.concat(chunks).toString('utf8'),
    deviceId: pathParts[2]
  };
}

function parseAccessLog(content, expectedDeviceId) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0 || lines.length > maxAccessLogEntries) {
    throw createHttpError('Quantidade de eventos inválida no arquivo.', 400);
  }

  return lines.map((line, index) => {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      throw createHttpError(`JSON inválido na linha ${index + 1}.`, 400);
    }

    const eventoId = typeof item.eventoId === 'string' ? item.eventoId.trim() : '';
    const dispositivoId = typeof item.dispositivoId === 'string' ? item.dispositivoId.trim() : '';
    const tagid = typeof item.tagid === 'string' ? item.tagid.trim() : '';
    const isoUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
    const accessDate = typeof item.acesso === 'string' && isoUtcPattern.test(item.acesso)
      ? new Date(item.acesso)
      : null;

    if (!eventoId || eventoId.length > 80 || !dispositivoId || dispositivoId.length > 80
        || dispositivoId !== expectedDeviceId || !tagid || tagid.length > 20
        || !accessDate || Number.isNaN(accessDate.getTime()) || typeof item.liberacao !== 'boolean') {
      throw createHttpError(`Evento inválido na linha ${index + 1}.`, 400);
    }

    return {
      eventoId,
      dispositivoId,
      tagid,
      acesso: accessDate.toISOString().slice(0, 19).replace('T', ' '),
      liberacao: item.liberacao
    };
  });
}

async function importAccessLog(records) {
  const connection = await pool.getConnection();
  const result = { processed: 0, rejected: 0, duplicates: 0 };

  try {
    await connection.beginTransaction();
    for (const record of records) {
      const [residents] = await connection.execute(
        'SELECT 1 FROM moradores WHERE TAGID = ? LIMIT 1',
        [record.tagid]
      );
      const accepted = residents.length > 0;
      const rejectionReason = accepted ? null : 'TAG não cadastrada.';
      const [importResult] = await connection.execute(
        `INSERT IGNORE INTO controle_acesso_importacao
          (evento_id, dispositivo_id, tagid, acesso, liberacao, status, motivo_rejeicao)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [record.eventoId, record.dispositivoId, record.tagid, record.acesso,
          record.liberacao, accepted ? 'PROCESSADO' : 'REJEITADO', rejectionReason]
      );

      if (importResult.affectedRows === 0) {
        result.duplicates += 1;
        continue;
      }

      if (!accepted) {
        result.rejected += 1;
        continue;
      }

      await connection.execute(
        'INSERT INTO `controle-acesso` (tagid, acesso, liberacao) VALUES (?, ?, ?)',
        [record.tagid, record.acesso, record.liberacao]
      );
      result.processed += 1;
    }
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function requirePortaria(req, res, next) {
  if (!req.session.authorized || req.session.accessType !== 'portaria') {
    return res.redirect('/login');
  }

  return next();
}

function requireMorador(req, res, next) {
  if (!req.session.authorized || req.session.accessType !== 'morador') {
    return res.redirect('/login-morador');
  }

  return next();
}

function requireEditPortariaAccess(req, res, next) {
  if (!req.session.editPortariaAllowed) {
    return res.redirect('/gestao');
  }

  return next();
}

async function initDatabase() {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query(`
      CREATE TABLE IF NOT EXISTS moradores (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome_completo VARCHAR(100) NOT NULL,
        email VARCHAR(150) NOT NULL UNIQUE,
        senha VARCHAR(255) NOT NULL,
        telefone VARCHAR(20),
        sexo VARCHAR(20),
        data_nascimento DATE,
        cidade VARCHAR(80),
        estado VARCHAR(80),
        endereco VARCHAR(200),
        numero VARCHAR(20),
        complemento VARCHAR(120),
        cep VARCHAR(12),
        TAGID VARCHAR(20) NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const [tagIndexes] = await connection.query("SHOW INDEX FROM moradores WHERE Column_name = 'TAGID' AND Non_unique = 0");
    if (tagIndexes.length === 0) {
      await connection.query('ALTER TABLE moradores ADD UNIQUE INDEX uq_moradores_tagid (TAGID)');
    }
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`controle-acesso\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tagid VARCHAR(20) NOT NULL,
        acesso DATETIME NOT NULL,
        liberacao BOOLEAN NOT NULL,
        CONSTRAINT fk_controle_acesso_morador_tagid
          FOREIGN KEY (tagid) REFERENCES moradores (TAGID) ON UPDATE CASCADE
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS controle_acesso_importacao (
        evento_id VARCHAR(80) NOT NULL,
        dispositivo_id VARCHAR(80) NOT NULL,
        tagid VARCHAR(20) NOT NULL,
        acesso DATETIME NOT NULL,
        liberacao BOOLEAN NOT NULL,
        recebido_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status ENUM('PROCESSADO', 'REJEITADO') NOT NULL,
        motivo_rejeicao VARCHAR(255) NULL,
        PRIMARY KEY (evento_id),
        KEY idx_importacao_dispositivo_acesso (dispositivo_id, acesso)
      )
    `);
    const [controleAcessoConstraint] = await connection.execute(
      `SELECT kcu.CONSTRAINT_NAME, rc.UPDATE_RULE
       FROM information_schema.KEY_COLUMN_USAGE kcu
       INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.TABLE_NAME = kcu.TABLE_NAME
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       WHERE kcu.TABLE_SCHEMA = DATABASE()
         AND kcu.TABLE_NAME = 'controle-acesso'
         AND kcu.COLUMN_NAME = 'tagid'
         AND kcu.REFERENCED_TABLE_NAME = 'moradores'
         AND kcu.REFERENCED_COLUMN_NAME = 'TAGID'`
    );
    if (controleAcessoConstraint.length > 0 && controleAcessoConstraint[0].UPDATE_RULE !== 'CASCADE') {
      const constraintName = controleAcessoConstraint[0].CONSTRAINT_NAME.replace(/`/g, '``');
      await connection.query(`ALTER TABLE \`controle-acesso\` DROP FOREIGN KEY \`${constraintName}\``);
    }
    if (controleAcessoConstraint.length === 0 || controleAcessoConstraint[0].UPDATE_RULE !== 'CASCADE') {
      await connection.query(
        'ALTER TABLE `controle-acesso` ADD CONSTRAINT fk_controle_acesso_morador_tagid FOREIGN KEY (tagid) REFERENCES moradores (TAGID) ON UPDATE CASCADE'
      );
    }
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`portaria-turnos\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(50) NOT NULL UNIQUE
      )
    `);
    await connection.query(`
      INSERT IGNORE INTO \`portaria-turnos\` (nome)
      VALUES ('Turno Diurno'), ('Turno Noturno'), ('Turno 1'), ('Turno 2'), ('Turno 3')
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS portaria (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome_completo VARCHAR(100) NOT NULL,
        email VARCHAR(150) NOT NULL UNIQUE,
        senha VARCHAR(255) NOT NULL,
        turno INT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_portaria_turno FOREIGN KEY (turno) REFERENCES \`portaria-turnos\` (id)
      )
    `);

    const [turnoColumn] = await connection.query("SHOW COLUMNS FROM portaria LIKE 'turno'");
    if (turnoColumn.length === 0) {
      await connection.query('ALTER TABLE portaria ADD COLUMN turno INT NULL AFTER senha');
    }

    const obsoleteColumns = [
      'telefone', 'sexo', 'data_nascimento', 'cidade', 'estado',
      'endereco', 'numero', 'complemento', 'cep', 'TAGID'
    ];
    const [portariaColumns] = await connection.query('SHOW COLUMNS FROM portaria');
    const existingColumns = new Set(portariaColumns.map((column) => column.Field));
    for (const column of obsoleteColumns) {
      if (existingColumns.has(column)) {
        await connection.query(`ALTER TABLE portaria DROP COLUMN \`${column}\``);
      }
    }

    const [turnoConstraint] = await connection.execute(
      `SELECT CONSTRAINT_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'portaria'
         AND COLUMN_NAME = 'turno'
         AND REFERENCED_TABLE_NAME = 'portaria-turnos'`
    );
    if (turnoConstraint.length === 0) {
      await connection.query(
        'ALTER TABLE portaria ADD CONSTRAINT fk_portaria_turno FOREIGN KEY (turno) REFERENCES `portaria-turnos` (id)'
      );
    }
    console.log('Banco inicializado com sucesso.');
  } catch (error) {
    console.error('Erro ao inicializar banco:', error.message);
    throw error;
  } finally {
    connection?.release();
  }
}

app.post('/api/events/blob-created', async (req, res) => {
  const receivedSecret = req.get('X-EventGrid-Webhook-Secret');
  if (!webhookSecretsMatch(receivedSecret, process.env.EVENT_GRID_WEBHOOK_SECRET)) {
    return res.sendStatus(401);
  }

  const events = Array.isArray(req.body) ? req.body : [req.body];
  const validationEvent = events.find(
    (event) => event?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent'
  );
  if (validationEvent?.data?.validationCode) {
    return res.json({ validationResponse: validationEvent.data.validationCode });
  }

  const blobEvents = events.filter(
    (event) => event?.eventType === 'Microsoft.Storage.BlobCreated' && event?.data?.url
  );
  if (blobEvents.length === 0) {
    return res.status(400).json({ error: 'Nenhum evento BlobCreated válido foi recebido.' });
  }

  try {
    const summary = { processed: 0, rejected: 0, duplicates: 0 };
    for (const event of blobEvents) {
      const { content, deviceId } = await downloadAccessLog(event.data.url);
      const result = await importAccessLog(parseAccessLog(content, deviceId));
      summary.processed += result.processed;
      summary.rejected += result.rejected;
      summary.duplicates += result.duplicates;
    }
    return res.json(summary);
  } catch (error) {
    console.error('Erro ao importar arquivo de acessos:', error.message);
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    return res.status(statusCode).json({
      error: statusCode >= 500 ? 'Não foi possível importar o arquivo de acessos.' : error.message
    });
  }
});

app.get('/', (req, res) => {
  res.redirect('/home');
});

app.get('/home', (req, res) => {
  res.render('home');
});

app.get('/login', (req, res) => {
  if (req.session.authorized && req.session.accessType === 'portaria') {
    return res.redirect('/gestao');
  }

  return res.render('login', { error: null, email: '' });
});

app.get('/login-morador', (req, res) => {
  if (req.session.authorized && req.session.accessType === 'morador') {
    return res.redirect('/menu-morador');
  }

  return res.render('login_morador', { error: null, email: '' });
});

app.post('/login-morador', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const emailNormalizado = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!emailNormalizado || typeof senha !== 'string' || !senha) {
      return res.status(400).render('login_morador', {
        error: 'Informe seu e-mail e sua senha.',
        email: emailNormalizado
      });
    }

    const [rows] = await pool.execute(
      'SELECT id, nome_completo, email, senha FROM moradores WHERE email = ? LIMIT 1',
      [emailNormalizado]
    );

    if (rows.length === 0) {
      return res.status(401).render('login_morador', {
        error: 'E-mail ou senha inválidos.',
        email: emailNormalizado
      });
    }

    const morador = rows[0];
    const senhaValida = await bcrypt.compare(senha, morador.senha);

    if (!senhaValida) {
      return res.status(401).render('login_morador', {
        error: 'E-mail ou senha inválidos.',
        email: emailNormalizado
      });
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => error ? reject(error) : resolve());
    });

    req.session.authorized = true;
    req.session.accessType = 'morador';
    req.session.user = {
      id: morador.id,
      nome: morador.nome_completo,
      email: morador.email,
      tipo: 'Morador'
    };

    return res.redirect('/menu-morador');
  } catch (error) {
    console.error('Erro no login do morador:', error);
    return res.status(500).render('login_morador', {
      error: 'Não foi possível entrar. Tente novamente mais tarde.',
      email: typeof req.body.email === 'string' ? req.body.email.trim() : ''
    });
  }
});

app.get('/cadastro-morador', (req, res) => {
  res.render('cadastro_morador', { error: null, success: null });
});

app.post('/cadastro-morador', async (req, res) => {
  try {
    const {
      nome,
      email,
      senha,
      telefone,
      genero,
      datanasc,
      cidade,
      estado,
      endereco,
      numero,
      complemento,
      cep
    } = req.body;

    const emailNormalizado = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!senha) {
      return res.render('cadastro_morador', {
        error: 'Campo obrigatório de preenchimento',
        success: null
      });
    }

    if (!nome || !emailNormalizado) {
      return res.render('cadastro_morador', {
        error: 'Nome e e-mail são obrigatórios.',
        success: null
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado)) {
      return res.render('cadastro_morador', {
        error: 'Informe um e-mail válido, com @ e um domínio completo.',
        success: null
      });
    }

    const telefoneDigits = (telefone || '').replace(/\D/g, '');
    if (telefoneDigits && !/^\d{10,11}$/.test(telefoneDigits)) {
      return res.render('cadastro_morador', {
        error: 'O telefone deve conter 10 ou 11 dígitos.',
        success: null
      });
    }

    const telefoneFormatado = telefoneDigits.length === 11
      ? `(${telefoneDigits.slice(0, 2)}) ${telefoneDigits.slice(2, 7)}-${telefoneDigits.slice(7)}`
      : telefoneDigits.length === 10
        ? `(${telefoneDigits.slice(0, 2)}) ${telefoneDigits.slice(2, 6)}-${telefoneDigits.slice(6)}`
        : null;

    const hash = await bcrypt.hash(senha, 10);
  const [existing] = await pool.execute('SELECT id FROM moradores WHERE email = ?', [emailNormalizado]);

    if (existing.length > 0) {
      return res.render('cadastro_morador', {
        error: 'Este e-mail já está cadastrado.',
        success: null
      });
    }

    await pool.execute(
      `INSERT INTO moradores (nome_completo, email, senha, telefone, sexo, data_nascimento, cidade, estado, endereco, numero, complemento, cep)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nome, emailNormalizado, hash, telefoneFormatado, genero, datanasc || null, cidade || null, estado || null, endereco || null, numero || null, complemento || null, cep || null]
    );

    return res.render('cadastro_morador', {
      error: null,
      success: 'Cadastro realizado com sucesso!'
    });
  } catch (error) {
    console.error('Erro ao cadastrar morador:', error);
    return res.render('cadastro_morador', {
      error: 'Não foi possível concluir o cadastro.',
      success: null
    });
  }
});

app.get('/cadastro-portaria', (req, res) => {
  res.render('cadastro_portaria', { error: null, success: null });
});

app.post('/cadastro-portaria', async (req, res) => {
  try {
    const { nome, email, senha, turno } = req.body;

    const emailNormalizado = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const turnoNome = typeof turno === 'string' ? turno.trim() : '';

    if (!nome || !emailNormalizado || !senha || !turnoNome) {
      return res.render('cadastro_portaria', {
        error: 'Porteiro, e-mail, senha e turno são obrigatórios.',
        success: null
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado)) {
      return res.render('cadastro_portaria', {
        error: 'Informe um e-mail válido, com @ e um domínio completo.',
        success: null
      });
    }

    const [turnos] = await pool.execute('SELECT id FROM `portaria-turnos` WHERE nome = ?', [turnoNome]);
    if (turnos.length === 0) {
      return res.render('cadastro_portaria', {
        error: 'Selecione um turno válido.',
        success: null
      });
    }

    const hash = await bcrypt.hash(senha, 10);
    const [existing] = await pool.execute('SELECT id FROM portaria WHERE email = ?', [emailNormalizado]);

    if (existing.length > 0) {
      return res.render('cadastro_portaria', {
        error: 'Este e-mail já está cadastrado.',
        success: null
      });
    }

    await pool.execute(
      'INSERT INTO portaria (nome_completo, email, senha, turno) VALUES (?, ?, ?, ?)',
      [nome, emailNormalizado, hash, turnos[0].id]
    );

    return res.render('cadastro_portaria', {
      error: null,
      success: 'Cadastro realizado com sucesso!'
    });
  } catch (error) {
    console.error('Erro ao cadastrar portaria:', error);
    return res.render('cadastro_portaria', {
      error: 'Não foi possível concluir o cadastro.',
      success: null
    });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const emailNormalizado = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!emailNormalizado || typeof senha !== 'string' || !senha) {
      return res.status(400).render('login', {
        error: 'Informe seu e-mail e sua senha.',
        email: emailNormalizado
      });
    }

    const [rows] = await pool.execute(
      'SELECT id, nome_completo, email, senha FROM portaria WHERE email = ? LIMIT 1',
      [emailNormalizado]
    );

    if (rows.length === 0) {
      return res.status(401).render('login', {
        error: 'E-mail ou senha inválidos.',
        email: emailNormalizado
      });
    }

    const usuario = rows[0];
    const valido = await bcrypt.compare(senha, usuario.senha);

    if (!valido) {
      return res.status(401).render('login', {
        error: 'E-mail ou senha inválidos.',
        email: emailNormalizado
      });
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => error ? reject(error) : resolve());
    });

    req.session.authorized = true;
    req.session.accessType = 'portaria';
    req.session.user = {
      id: usuario.id,
      nome: usuario.nome_completo,
      email: usuario.email,
      tipo: 'Portaria'
    };

    return res.redirect('/gestao');
  } catch (error) {
    console.error('Erro no login:', error);
    return res.status(500).render('login', {
      error: 'Não foi possível entrar. Tente novamente mais tarde.',
      email: typeof req.body.email === 'string' ? req.body.email.trim() : ''
    });
  }
});

app.get('/gestao', requirePortaria, (req, res) => {
  req.session.editPortariaAllowed = false;
  req.session.editPortariaToken = randomUUID();

  return res.render('gestao', {
    user: req.session.user,
    editPortariaToken: req.session.editPortariaToken
  });
});

app.get('/lista-acesso-gestao', requirePortaria, async (req, res) => {
  const data = typeof req.query.data === 'string' ? req.query.data.trim() : '';
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  const situacaoInformada = typeof req.query.situacao === 'string' ? req.query.situacao.trim().toLowerCase() : '';
  const situacao = ['liberado', 'bloqueado'].includes(situacaoInformada) ? situacaoInformada : '';
  const conditions = [];
  const values = [];

  if (data && /^\d{4}-\d{2}-\d{2}$/.test(data)) {
    conditions.push('DATE(ca.acesso) = ?');
    values.push(data);
  }

  if (email) {
    conditions.push('LOWER(m.email) LIKE ?');
    values.push(`%${email}%`);
  }

  if (situacao) {
    conditions.push('ca.liberacao = ?');
    values.push(situacao === 'liberado' ? 1 : 0);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const [acessos] = await pool.execute(
            `SELECT ca.id, ca.tagid, DATE_FORMAT(ca.acesso, '%d/%m/%Y %H:%i:%s') AS acesso,
              ca.liberacao, m.nome_completo, m.email
       FROM \`controle-acesso\` ca
       INNER JOIN moradores m ON m.TAGID = ca.tagid
       ${where}
       ORDER BY ca.acesso DESC, ca.id DESC`,
      values
    );

    return res.render('lista_acesso_gestao', {
      user: req.session.user,
      acessos,
      filtros: { data, email, situacao },
      error: null
    });
  } catch (error) {
    console.error('Erro ao listar acessos da portaria:', error);
    return res.status(500).render('lista_acesso_gestao', {
      user: req.session.user,
      acessos: [],
      filtros: { data, email, situacao },
      error: 'Não foi possível carregar os registros de acesso.'
    });
  }
});

app.post('/gestao/acessar-edicao-portaria', requirePortaria, (req, res) => {
  const token = typeof req.body.token === 'string' ? req.body.token : '';

  if (!token || token !== req.session.editPortariaToken) {
    return res.redirect('/gestao');
  }

  delete req.session.editPortariaToken;
  req.session.editPortariaAllowed = true;
  return res.redirect('/gestao/editar-portaria');
});

app.get('/gestao/editar-portaria', requirePortaria, requireEditPortariaAccess, async (req, res) => {
  try {
    const [portariaResult, turnosResult] = await Promise.all([
      pool.execute('SELECT id, nome_completo, email, turno FROM portaria WHERE id = ?', [req.session.user.id]),
      pool.query('SELECT id, nome FROM `portaria-turnos` ORDER BY id')
    ]);
    const [portaria] = portariaResult;
    const [turnos] = turnosResult;

    if (portaria.length === 0) {
      return req.session.destroy(() => res.redirect('/login'));
    }

    return res.render('editar_portaria', {
      portaria: portaria[0],
      turnos,
      error: null,
      success: null
    });
  } catch (error) {
    console.error('Erro ao abrir edição da portaria:', error);
    return res.redirect('/gestao');
  }
});

app.post('/gestao/editar-portaria', requirePortaria, requireEditPortariaAccess, async (req, res) => {
  const { nome, email, senha, turno } = req.body;
  const emailNormalizado = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const turnoId = Number(turno);

  try {
    const [turnos] = await pool.query('SELECT id, nome FROM `portaria-turnos` ORDER BY id');

    if (!nome || !emailNormalizado || !Number.isInteger(turnoId) || !turnos.some((item) => item.id === turnoId)) {
      return res.status(400).render('editar_portaria', {
        portaria: { id: req.session.user.id, nome_completo: nome, email: emailNormalizado, turno: turnoId },
        turnos,
        error: 'Nome, e-mail e turno são obrigatórios.',
        success: null
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado)) {
      return res.status(400).render('editar_portaria', {
        portaria: { id: req.session.user.id, nome_completo: nome, email: emailNormalizado, turno: turnoId },
        turnos,
        error: 'Informe um e-mail válido.',
        success: null
      });
    }

    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await pool.execute(
        'UPDATE portaria SET nome_completo = ?, email = ?, senha = ?, turno = ? WHERE id = ?',
        [nome, emailNormalizado, hash, turnoId, req.session.user.id]
      );
    } else {
      await pool.execute(
        'UPDATE portaria SET nome_completo = ?, email = ?, turno = ? WHERE id = ?',
        [nome, emailNormalizado, turnoId, req.session.user.id]
      );
    }

    req.session.user.nome = nome;
    req.session.user.email = emailNormalizado;

    return res.render('editar_portaria', {
      portaria: { id: req.session.user.id, nome_completo: nome, email: emailNormalizado, turno: turnoId },
      turnos,
      error: null,
      success: 'Usuário de portaria atualizado com sucesso!'
    });
  } catch (error) {
    console.error('Erro ao editar usuário da portaria:', error);
    const [turnos] = await pool.query('SELECT id, nome FROM `portaria-turnos` ORDER BY id');
    return res.status(500).render('editar_portaria', {
      portaria: { id: req.session.user.id, nome_completo: nome, email: emailNormalizado, turno: turnoId },
      turnos,
      error: error.code === 'ER_DUP_ENTRY' ? 'Este e-mail já está cadastrado.' : 'Não foi possível atualizar o usuário.',
      success: null
    });
  }
});

app.get('/gestao/cadastro-tag-morador', requirePortaria, (req, res) => {
  return res.render('cadastro_tag_morador', {
    error: null,
    success: null,
    email: '',
    tag: '',
    morador: null,
    confirmation: false
  });
});

app.get('/gestao/troca-senha-morador', requirePortaria, (req, res) => {
  return res.render('troca_senha_morador', {
    error: null,
    success: null,
    email: '',
    morador: null
  });
});

app.post('/gestao/troca-senha-morador', requirePortaria, async (req, res) => {
  const emailNormalizado = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const senha = typeof req.body.senha === 'string' ? req.body.senha : '';
  const action = typeof req.body.action === 'string' ? req.body.action : 'localizar';

  if (!emailNormalizado) {
    return res.status(400).render('troca_senha_morador', {
      error: 'Informe o e-mail do morador.',
      success: null,
      email: emailNormalizado,
      morador: null
    });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id, nome_completo, email FROM moradores WHERE email = ? LIMIT 1',
      [emailNormalizado]
    );

    if (rows.length === 0) {
      return res.status(404).render('troca_senha_morador', {
        error: 'Morador não encontrado.',
        success: null,
        email: emailNormalizado,
        morador: null
      });
    }

    const morador = rows[0];

    if (action === 'localizar') {
      return res.render('troca_senha_morador', {
        error: null,
        success: null,
        email: emailNormalizado,
        morador
      });
    }

    if (!senha) {
      return res.status(400).render('troca_senha_morador', {
        error: 'Informe a nova senha do morador.',
        success: null,
        email: emailNormalizado,
        morador
      });
    }

    const hash = await bcrypt.hash(senha, 10);
    await pool.execute('UPDATE moradores SET senha = ? WHERE id = ?', [hash, morador.id]);

    return res.render('troca_senha_morador', {
      error: null,
      success: 'Senha do morador alterada com sucesso!',
      email: emailNormalizado,
      morador
    });
  } catch (error) {
    console.error('Erro ao trocar senha do morador:', error);
    return res.status(500).render('troca_senha_morador', {
      error: 'Não foi possível alterar a senha do morador.',
      success: null,
      email: emailNormalizado,
      morador: null
    });
  }
});

app.post('/gestao/cadastro-tag-morador', requirePortaria, async (req, res) => {
  const emailNormalizado = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const tag = typeof req.body.tag === 'string' ? req.body.tag.trim() : '';
  const action = typeof req.body.action === 'string' ? req.body.action : 'localizar';

  if (!emailNormalizado) {
    return res.status(400).render('cadastro_tag_morador', {
      error: 'Informe o e-mail do morador.',
      success: null,
      email: emailNormalizado,
      tag,
      morador: null,
      confirmation: false
    });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id, nome_completo, email, TAGID FROM moradores WHERE email = ? LIMIT 1',
      [emailNormalizado]
    );

    if (rows.length === 0) {
      return res.status(404).render('cadastro_tag_morador', {
        error: 'Morador não encontrado.',
        success: null,
        email: emailNormalizado,
        tag,
        morador: null,
        confirmation: false
      });
    }

    const morador = rows[0];

    if (action === 'localizar') {
      return res.render('cadastro_tag_morador', {
        error: null,
        success: null,
        email: emailNormalizado,
        tag: '',
        morador,
        confirmation: false
      });
    }

    if (action === 'cancelar') {
      return res.render('cadastro_tag_morador', {
        error: null,
        success: 'Nada foi alterado.',
        email: emailNormalizado,
        tag: '',
        morador,
        confirmation: false
      });
    }

    if (!tag && !morador.TAGID) {
      return res.status(400).render('cadastro_tag_morador', {
        error: 'Informe uma TAG para realizar o cadastro.',
        success: null,
        email: emailNormalizado,
        tag,
        morador,
        confirmation: false
      });
    }

    if (!tag) {
      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();
        const [acessos] = await connection.execute(
          'SELECT id FROM `controle-acesso` WHERE tagid = ? LIMIT 1 FOR UPDATE',
          [morador.TAGID]
        );

        if (acessos.length > 0) {
          await connection.rollback();
          return res.status(409).render('cadastro_tag_morador', {
            error: 'A ação não pode ser executada pois ja há registro de acessos',
            success: null,
            email: emailNormalizado,
            tag: '',
            morador,
            confirmation: false
          });
        }

        await connection.execute('UPDATE moradores SET TAGID = NULL WHERE id = ?', [morador.id]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      await publishResidentsSnapshot();

      return res.render('cadastro_tag_morador', {
        error: null,
        success: 'TAG removida com sucesso!',
        email: emailNormalizado,
        tag: '',
        morador: { ...morador, TAGID: null },
        confirmation: false
      });
    }

    const [tagEmUso] = await pool.execute(
      'SELECT id FROM moradores WHERE TAGID = ? AND id <> ? LIMIT 1',
      [tag, morador.id]
    );

    if (tagEmUso.length > 0) {
      return res.status(409).render('cadastro_tag_morador', {
        error: 'A TAG já está associada a outro usuário.',
        success: null,
        email: emailNormalizado,
        tag,
        morador,
        confirmation: false
      });
    }

    if (action === 'salvar' && morador.TAGID && morador.TAGID !== tag) {
      return res.render('cadastro_tag_morador', {
        error: null,
        success: null,
        email: emailNormalizado,
        tag,
        morador,
        confirmation: true
      });
    }

    if (morador.TAGID === tag) {
      return res.render('cadastro_tag_morador', {
        error: null,
        success: 'A TAG informada já está cadastrada. Nada foi alterado.',
        email: emailNormalizado,
        tag: '',
        morador,
        confirmation: false
      });
    }

    await pool.execute('UPDATE moradores SET TAGID = ? WHERE id = ?', [tag, morador.id]);
    await publishResidentsSnapshot();

    return res.render('cadastro_tag_morador', {
      error: null,
      success: morador.TAGID ? 'TAG alterada com sucesso!' : 'TAG cadastrada com sucesso!',
      email: emailNormalizado,
      tag: '',
      morador: { ...morador, TAGID: tag },
      confirmation: false
    });
  } catch (error) {
    console.error('Erro ao cadastrar TAG do morador:', error);
    return res.status(500).render('cadastro_tag_morador', {
      error: error.code === 'ER_DUP_ENTRY'
        ? 'A TAG já está associada a outro usuário.'
        : 'Não foi possível cadastrar a TAG.',
      success: null,
      email: emailNormalizado,
      tag,
      morador: null,
      confirmation: false
    });
  }
});

app.get('/menu-morador', requireMorador, (req, res) => {
  return res.render('menu_morador', { user: req.session.user });
});

app.get('/edicao-morador', requireMorador, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, nome_completo, email, telefone, sexo,
              DATE_FORMAT(data_nascimento, '%Y-%m-%d') AS data_nascimento,
              cidade, estado, endereco, numero, complemento, cep, TAGID
       FROM moradores WHERE id = ? LIMIT 1`,
      [req.session.user.id]
    );

    if (rows.length === 0) {
      return req.session.destroy(() => res.redirect('/login-morador'));
    }

    return res.render('edicao_morador', { morador: rows[0], error: null, success: null });
  } catch (error) {
    console.error('Erro ao abrir edição do morador:', error);
    return res.redirect('/menu-morador');
  }
});

app.post('/edicao-morador', requireMorador, async (req, res) => {
  const { email, senha, telefone, genero, datanasc, cidade, estado, endereco, numero, complemento, cep } = req.body;
  const emailNormalizado = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const telefoneDigits = (telefone || '').replace(/\D/g, '');

  try {
    const [rows] = await pool.execute(
      `SELECT id, nome_completo, TAGID FROM moradores WHERE id = ? LIMIT 1`,
      [req.session.user.id]
    );

    if (rows.length === 0) {
      return req.session.destroy(() => res.redirect('/login-morador'));
    }

    const moradorAtual = rows[0];
    const viewData = {
      ...moradorAtual,
      email: emailNormalizado,
      telefone,
      sexo: genero,
      data_nascimento: datanasc,
      cidade,
      estado,
      endereco,
      numero,
      complemento,
      cep
    };

    if (!emailNormalizado || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado)) {
      return res.status(400).render('edicao_morador', {
        morador: viewData,
        error: 'Informe um e-mail válido.',
        success: null
      });
    }

    if (telefoneDigits && !/^\d{10,11}$/.test(telefoneDigits)) {
      return res.status(400).render('edicao_morador', {
        morador: viewData,
        error: 'O telefone deve conter 10 ou 11 dígitos.',
        success: null
      });
    }

    const telefoneFormatado = telefoneDigits.length === 11
      ? `(${telefoneDigits.slice(0, 2)}) ${telefoneDigits.slice(2, 7)}-${telefoneDigits.slice(7)}`
      : telefoneDigits.length === 10
        ? `(${telefoneDigits.slice(0, 2)}) ${telefoneDigits.slice(2, 6)}-${telefoneDigits.slice(6)}`
        : null;

    const values = [
      emailNormalizado, telefoneFormatado, genero || null, datanasc || null,
      cidade || null, estado || null, endereco || null, numero || null,
      complemento || null, cep || null
    ];

    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await pool.execute(
        `UPDATE moradores
         SET email = ?, telefone = ?, sexo = ?, data_nascimento = ?, cidade = ?, estado = ?,
             endereco = ?, numero = ?, complemento = ?, cep = ?, senha = ?
         WHERE id = ?`,
        [...values, hash, req.session.user.id]
      );
    } else {
      await pool.execute(
        `UPDATE moradores
         SET email = ?, telefone = ?, sexo = ?, data_nascimento = ?, cidade = ?, estado = ?,
             endereco = ?, numero = ?, complemento = ?, cep = ?
         WHERE id = ?`,
        [...values, req.session.user.id]
      );
    }

    req.session.user.email = emailNormalizado;
    return res.render('edicao_morador', {
      morador: { ...viewData, telefone: telefoneFormatado },
      error: null,
      success: 'Cadastro atualizado com sucesso!'
    });
  } catch (error) {
    console.error('Erro ao editar morador:', error);
    return res.status(500).render('edicao_morador', {
      morador: {
        id: req.session.user.id,
        nome_completo: req.session.user.nome,
        email: emailNormalizado,
        telefone,
        sexo: genero,
        data_nascimento: datanasc,
        cidade,
        estado,
        endereco,
        numero,
        complemento,
        cep,
        TAGID: null
      },
      error: error.code === 'ER_DUP_ENTRY' ? 'Este e-mail já está cadastrado.' : 'Não foi possível atualizar o cadastro.',
      success: null
    });
  }
});

app.get('/acessos-morador', requireMorador, async (req, res) => {
  const data = typeof req.query.data === 'string' ? req.query.data.trim() : '';
  const situacaoInformada = typeof req.query.situacao === 'string' ? req.query.situacao.trim().toLowerCase() : '';
  const situacao = ['liberado', 'bloqueado'].includes(situacaoInformada) ? situacaoInformada : '';

  try {
    const [moradores] = await pool.execute(
      'SELECT nome_completo, email, TAGID FROM moradores WHERE id = ? LIMIT 1',
      [req.session.user.id]
    );

    if (moradores.length === 0) {
      return req.session.destroy(() => res.redirect('/login-morador'));
    }

    const conditions = ['m.id = ?'];
    const values = [req.session.user.id];

    if (data && /^\d{4}-\d{2}-\d{2}$/.test(data)) {
      conditions.push('DATE(ca.acesso) = ?');
      values.push(data);
    }

    if (situacao) {
      conditions.push('ca.liberacao = ?');
      values.push(situacao === 'liberado' ? 1 : 0);
    }

    const [acessos] = await pool.execute(
      `SELECT ca.id, ca.tagid, DATE_FORMAT(ca.acesso, '%d/%m/%Y %H:%i:%s') AS acesso,
              ca.liberacao
       FROM \`controle-acesso\` ca
       INNER JOIN moradores m ON m.TAGID = ca.tagid
       WHERE ${conditions.join(' AND ')}
       ORDER BY ca.acesso DESC, ca.id DESC`,
      values
    );

    return res.render('acessos_morador', {
      morador: moradores[0],
      acessos,
      filtros: { data, situacao },
      error: null
    });
  } catch (error) {
    console.error('Erro ao visualizar acessos do morador:', error);
    return res.status(500).render('acessos_morador', {
      morador: {
        nome_completo: req.session.user.nome,
        email: req.session.user.email,
        TAGID: null
      },
      acessos: [],
      filtros: { data, situacao },
      error: 'Não foi possível carregar seus registros de acesso.'
    });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/home'));
});

app.get('/health/live', (req, res) => {
  res.json({ status: 'live' });
});

app.get('/health/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ready' });
  } catch {
    return res.status(503).json({ status: 'not ready' });
  }
});

try {
  await initDatabase();
  await publishResidentsSnapshot();
} catch {
  await pool.end();
  process.exit(1);
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor em http://localhost:${port}`);
});
