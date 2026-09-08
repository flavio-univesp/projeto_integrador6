import express from 'express';
import session from 'express-session';
import ejs from 'ejs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

app.engine('ejs', ejs.renderFile);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'condoservicos-home-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'strict'
  }
}));

const dbConfig = {
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'condoservicos',
  password: process.env.DB_PASSWORD || 'condoservicos123',
  database: process.env.DB_NAME || 'condoservicos',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
};

const pool = mysql.createPool(dbConfig);

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
  try {
    const connection = await pool.getConnection();
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
          FOREIGN KEY (tagid) REFERENCES moradores (TAGID)
      )
    `);
    const [controleAcessoConstraint] = await connection.execute(
      `SELECT CONSTRAINT_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'controle-acesso'
         AND COLUMN_NAME = 'tagid'
         AND REFERENCED_TABLE_NAME = 'moradores'
         AND REFERENCED_COLUMN_NAME = 'TAGID'`
    );
    if (controleAcessoConstraint.length === 0) {
      await connection.query(
        'ALTER TABLE `controle-acesso` ADD CONSTRAINT fk_controle_acesso_morador_tagid FOREIGN KEY (tagid) REFERENCES moradores (TAGID)'
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
    connection.release();
    console.log('Banco inicializado com sucesso.');
  } catch (error) {
    console.error('Erro ao inicializar banco:', error.message);
  }
}

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

    if (!tag) {
      return res.status(400).render('cadastro_tag_morador', {
        error: 'Informe a TAG.',
        success: null,
        email: emailNormalizado,
        tag,
        morador,
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

initDatabase();

app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor em http://localhost:${port}`);
});
