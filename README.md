
<p align="center"> <i>Desenvolvido com dedicação pelo grupo <strong>CondoAcessos</strong> — Projeto Integrador em Computação VI (UNIVESP, 2026)</i> </p> </div>

<p align="center">
  <img src="https://user-images.githubusercontent.com/50468352/141820811-412e9364-7f5c-4889-826a-fcba23b92e23.png" width="350" alt="Logo do Projeto" />
</p>

<h3 align="center">📌 Projeto Integrador em Computação VI - 2026</h3>

<p align="center"><strong>Polos:</strong> Araras-SP, Campinas-SP, Elias Fausto-SP, Estiva Gerbi-SP, Indaiatuba-SP, Leme-SP, Várzea Paulista-SP</p>
<p align="center"><strong>Orientadora do PI:</strong> Aline Santana</p>

---

## 👥 Integrantes do grupo

| Nome                                | RA       |
|-------------------------------------|----------|
| Daniel Anunciato                    | 2222677  |
| Eder Clauber dos Santos dos Anjos   | 1806662  |
| Felipe Rafael Henriques             | 2214261  |
| Flavio Jorge de Medeiros            | 23205233 |
| Francisco Ribeiro da Silva Junior   | 2108392  |
| Kelven Joseph Machado Santos        | 2100626  |
| Matheus Eduardo Peixoto de Carvalho | 2205301  |
| Nicolly de Sousa Lima               | 2205907  |

---

## 💡 Projeto: *CondoAcesso — Controle de Acessos para Condomínios*

> **Aplicação web para cadastro de moradores, gestão de usuários da portaria, associação de TAGs RFID, integração com dispositivos IoT e consulta do histórico de acessos à portaria central.**

O projeto utiliza Node.js, Express, EJS e MySQL 8. Localmente, a aplicação e o banco de dados são executados em containers Docker coordenados pelo Docker Compose. No Azure, a aplicação publica as TAGs autorizadas no Blob Storage e importa os registros enviados pelos dispositivos por meio do IoT Hub e do Event Grid.

---

## Funcionalidades

### Morador

- Cadastro e autenticação independentes.
- Menu exclusivo após o login.
- Consulta e atualização dos próprios dados.
- Nome e TAGID protegidos contra alterações pelo morador.
- Consulta exclusiva do próprio histórico de acessos.
- Filtros combináveis por data e situação.
- Situações apresentadas como `Liberado` ou `Bloqueado`.

### Portaria

- Cadastro e autenticação independentes.
- Edição protegida do próprio usuário e turno.
- Localização de morador por e-mail.
- Associação e substituição confirmada de TAGID.
- Consulta de todos os acessos à portaria central.
- Filtros combináveis por data, e-mail do morador e situação.
- Identificação separada de acessos liberados, bloqueados e negados por TAG não cadastrada.

### Integração IoT

- Publicação da lista de TAGs autorizadas no blob `residentes/tags-autorizadas.json`.
- Recebimento de eventos `BlobCreated` do Event Grid em um endpoint autenticado por segredo.
- Importação transacional de arquivos NDJSON enviados pelos dispositivos ao container `logs-acesso`.
- Validação do dispositivo, TAGID, data UTC, decisão de liberação e tamanho do arquivo.
- Idempotência pelo campo `eventoId`, com contabilização de eventos duplicados e rejeitados.
- Recuperação de arquivos NDJSON pendentes durante a inicialização da aplicação.
- Exclusão do blob de acesso após a importação bem-sucedida.

## Tecnologias

| Componente | Tecnologia |
|---|---|
| Backend | Node.js 22 e Express 5 |
| Templates | EJS 3 |
| Banco de dados | MySQL 8 |
| Acesso ao banco | mysql2/promise |
| Autenticação | express-session e bcrypt |
| Integração Azure | `@azure/identity` e `@azure/storage-blob` |
| Ingestão IoT | Azure IoT Hub e Event Grid |
| Frontend | HTML, CSS e JavaScript |
| Containers | Docker e Docker Compose |

## Estrutura do projeto

```text
.
├── compose.yaml
├── Dockerfile
├── package.json
├── server.js
├── condoservicos.sql
├── public/
│   ├── cadastro_morador/
│   ├── cadastro_portaria/
│   ├── gestao/
│   ├── home/
│   └── login/
└── views/
    ├── acessos_morador.ejs
    ├── cadastro_morador.ejs
    ├── cadastro_portaria.ejs
    ├── cadastro_tag_morador.ejs
    ├── edicao_morador.ejs
    ├── editar_portaria.ejs
    ├── gestao.ejs
    ├── home.ejs
    ├── lista_acesso_gestao.ejs
    ├── login.ejs
    ├── login_morador.ejs
    └── menu_morador.ejs
```

## Arquitetura Docker

O arquivo `compose.yaml` define dois serviços:

| Serviço | Imagem | Porta publicada | Persistência |
|---|---|---|---|
| `app` | Construída pelo `Dockerfile` com Node.js 22 | `3001:3000` | Código incorporado à imagem |
| `db` | `mysql:8.0` | `3306:3306` | Volume `mysql_data` |

O serviço `app` só inicia depois que o healthcheck do MySQL informa que o banco está saudável.

## Lista de TAGs para o dispositivo

A aplicação publica o blob `tags-autorizadas.json` no container `residentes` ao iniciar e depois de cada cadastro, alteração ou remoção de TAG feita pela tela de cadastro de TAG do morador. O arquivo contém somente TAGs associadas a moradores:

```json
{
    "version": "2026-09-15T18:30:00.000Z",
    "generatedAt": "2026-09-15T18:30:00.000Z",
    "tags": [
        { "tagid": "23 7E 5B 63" }
    ]
}
```

Quando não existem TAGs cadastradas, `tags` é um array vazio. No Azure, o upload usa a Managed Identity atribuída ao Container App; nenhuma chave do Storage é armazenada na aplicação.

## Ingestão dos registros de acesso

O dispositivo envia arquivos `.ndjson` ao container configurado em `ACCESS_LOGS_BLOB_CONTAINER_NAME`. Cada linha representa um evento independente:

```json
{"eventoId":"portaria-01-000001","dispositivoId":"portaria-01","tagid":"23 7E 5B 63","acesso":"2026-09-17T21:15:00Z","liberacao":true}
```

O Event Grid notifica o endpoint `POST /api/events/blob-created` quando um blob NDJSON é criado. A aplicação aceita somente URLs HTTPS da conta e do contêiner configurados, confere se o identificador do dispositivo corresponde ao caminho do blob e limita cada arquivo a 1 MiB e 5.000 eventos.

Eventos de TAGs cadastradas são gravados em `controle-acesso` e marcados como `PROCESSADO` no histórico de importação. Eventos de TAGs desconhecidas são mantidos em `controle_acesso_importacao` como `REJEITADO`, com o motivo `TAG não cadastrada.`, e aparecem como `Negado` na tela da portaria. O blob é removido somente depois da conclusão da transação.

## Modelo de dados

```mermaid
erDiagram
    MORADORES ||--o{ CONTROLE_ACESSO : possui
    PORTARIA_TURNOS ||--o{ PORTARIA : define

    MORADORES {
        INT id PK
        VARCHAR nome_completo
        VARCHAR email UK
        VARCHAR senha
        VARCHAR telefone
        VARCHAR sexo
        DATE data_nascimento
        VARCHAR cidade
        VARCHAR estado
        VARCHAR endereco
        VARCHAR numero
        VARCHAR complemento
        VARCHAR cep
        VARCHAR TAGID UK
        TIMESTAMP criado_em
    }

    CONTROLE_ACESSO {
        INT id PK
        VARCHAR tagid FK
        DATETIME acesso
        BOOLEAN liberacao
    }

    CONTROLE_ACESSO_IMPORTACAO {
        VARCHAR evento_id PK
        VARCHAR dispositivo_id
        VARCHAR tagid
        DATETIME acesso
        BOOLEAN liberacao
        TIMESTAMP recebido_em
        ENUM status
        VARCHAR motivo_rejeicao
    }

    PORTARIA_TURNOS {
        INT id PK
        VARCHAR nome UK
    }

    PORTARIA {
        INT id PK
        VARCHAR nome_completo
        VARCHAR email UK
        VARCHAR senha
        INT turno FK
        TIMESTAMP criado_em
    }
```

### Relacionamentos

- `controle-acesso.tagid` referencia `moradores.TAGID`: um morador pode possuir vários registros de acesso.
- `controle_acesso_importacao.evento_id` garante a idempotência da ingestão e registra eventos processados ou rejeitados.
- `portaria.turno` referencia `portaria-turnos.id`: um turno pode estar associado a vários usuários da portaria.
- `moradores.email`, `moradores.TAGID`, `portaria.email` e `portaria-turnos.nome` são únicos.
- O MySQL armazena `BOOLEAN` como `TINYINT(1)`: `1` representa liberado e `0` representa bloqueado.

O `server.js` cria as tabelas, índices, relacionamentos e turnos iniciais de maneira idempotente ao iniciar a aplicação.

## Rotas

### Públicas

| Método | Rota | Finalidade |
|---|---|---|
| GET | `/` | Redireciona para `/home` |
| GET | `/home` | Página inicial |
| POST | `/api/events/blob-created` | Handshake e eventos do Event Grid; exige o cabeçalho secreto |
| GET | `/health/live` | Verificação de disponibilidade do processo |
| GET | `/health/ready` | Verificação de disponibilidade do banco de dados |
| GET/POST | `/login` | Autenticação da portaria |
| GET/POST | `/login-morador` | Autenticação do morador |
| GET/POST | `/cadastro-portaria` | Cadastro de usuário da portaria |
| GET/POST | `/cadastro-morador` | Cadastro de morador |
| GET | `/logout` | Encerra a sessão |

### Protegidas da portaria

| Método | Rota | Finalidade |
|---|---|---|
| GET | `/gestao` | Menu da portaria |
| GET | `/lista-acesso-gestao` | Histórico geral com filtros |
| POST | `/gestao/acessar-edicao-portaria` | Autoriza o fluxo de edição |
| GET/POST | `/gestao/editar-portaria` | Edição do usuário autenticado |
| GET/POST | `/gestao/cadastro-tag-morador` | Associação de TAG ao morador |

### Protegidas do morador

| Método | Rota | Finalidade |
|---|---|---|
| GET | `/menu-morador` | Menu do morador |
| GET/POST | `/edicao-morador` | Edição do próprio cadastro |
| GET | `/acessos-morador` | Histórico exclusivo do morador |

## Variáveis de ambiente

Crie `.env` a partir de `.env.example`:

```powershell
Copy-Item .env.example .env
```

| Variável | Descrição | Exemplo |
|---|---|---|
| `PORT` | Porta interna da aplicação | `3000` |
| `NODE_ENV` | Ambiente de execução | `development` |
| `DB_HOST` | Host MySQL; no Compose deve ser `db` | `db` |
| `DB_PORT` | Porta interna do MySQL | `3306` |
| `DB_NAME` | Nome do banco | `condoservicos` |
| `DB_USER` | Usuário da aplicação | `condoservicos` |
| `DB_PASSWORD` | Senha do usuário da aplicação | Definida localmente |
| `DB_ROOT_PASSWORD` | Senha do usuário root usada pelo contêiner MySQL | Definida localmente |
| `SESSION_SECRET` | Segredo de assinatura das sessões | Valor longo e aleatório |
| `DB_SSL` | Ativa SSL no cliente MySQL quando `true` | `false` |
| `AZURE_CLIENT_ID` | Client ID da Managed Identity atribuída à aplicação | Fornecido pelo Terraform |
| `AZURE_STORAGE_ACCOUNT_NAME` | Nome da conta de armazenamento usada pelas integrações | `stcondoacesso...` |
| `RESIDENTS_BLOB_CONTAINER_NAME` | Container da lista de TAGs autorizadas | `residentes` |
| `ACCESS_LOGS_BLOB_CONTAINER_NAME` | Container dos arquivos NDJSON de acesso | `logs-acesso` |
| `EVENT_GRID_WEBHOOK_SECRET` | Segredo comparado ao header `X-EventGrid-Webhook-Secret` | Valor longo e aleatório |

As variáveis `EMAIL_ENABLED`, `EMAIL_USER`, `EMAIL_PASSWORD` e `EMAIL_TO` estão reservadas no exemplo de ambiente, mas o envio de e-mails não faz parte dos fluxos atuais.

Em desenvolvimento, as integrações com o Blob Storage são ignoradas quando as variáveis do Azure não estão preenchidas. Em produção, a ausência dos contêineres configurados impede a inicialização. A autenticação no Azure usa `DefaultAzureCredential`; no Container App, informe `AZURE_CLIENT_ID` para selecionar a Managed Identity atribuída pelo usuário.

Nunca publique o arquivo `.env`. Em produção, substitua todas as credenciais de exemplo e use um `SESSION_SECRET` forte.

## Execução com Docker

### Pré-requisitos

- Docker Desktop ou Docker Engine com Docker Compose.
- Portas `3001` e `3306` disponíveis.

### Primeira execução

```powershell
Copy-Item .env.example .env
docker compose up -d --build
docker compose ps
docker compose logs app --tail 30
```

Acesse:

```text
http://localhost:3001/home
```

O banco é criado automaticamente. Sem restauração de backup, as tabelas estarão vazias, exceto pelos turnos iniciais.

### Parar e iniciar

```powershell
docker compose stop
docker compose start
```

Também é possível recriar os contêineres preservando o volume do banco:

```powershell
docker compose down
docker compose up -d
```

### Reconstruir após alterar o código

```powershell
docker compose build --no-cache app
docker compose up -d app
```

Ou em um único comando:

```powershell
docker compose up -d --build
```

## Backup e restauração

O arquivo `condoservicos.sql` é um dump completo da estrutura, relacionamentos e dados existentes no momento de sua geração.

### Gerar um novo backup

```powershell
$db = docker compose ps -q db

docker exec $db sh -c 'mysqldump -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" --single-transaction --routines --triggers --events --hex-blob --no-tablespaces --set-gtid-purged=OFF "$MYSQL_DATABASE" > /tmp/condoservicos.sql'

docker cp "${db}:/tmp/condoservicos.sql" .\condoservicos.sql
docker exec $db rm /tmp/condoservicos.sql
```

### Restaurar o backup em um volume novo

Suba somente o banco:

```powershell
docker compose up -d --wait db
$db = docker compose ps -q db
```

Copie e restaure o dump:

```powershell
docker cp .\condoservicos.sql "${db}:/tmp/condoservicos.sql"

docker exec $db sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" < /tmp/condoservicos.sql'

docker exec $db rm /tmp/condoservicos.sql
docker compose up -d app
```

Para restaurar sobre um banco que já contém dados, faça primeiro um backup atualizado. O dump inclui comandos de remoção e recriação das tabelas.

## Transporte para uma máquina sem possibilidade de build

Use este fluxo quando a máquina de destino puder executar o Docker, mas não puder baixar dependências nem construir a aplicação devido a restrições de segurança.

### Na máquina de origem

Construa e identifique a imagem da aplicação:

```powershell
docker compose build --no-cache app
$appImage = docker compose images -q app
docker tag $appImage condoservicos-app:1.0
```

Exporte as imagens da aplicação e do MySQL:

```powershell
docker pull mysql:8.0
docker save -o condoservicos-imagens.tar condoservicos-app:1.0 mysql:8.0
```

Gere um backup atualizado usando o procedimento da seção anterior. Transfira os seguintes itens para a máquina de destino:

- O projeto completo.
- `condoservicos-imagens.tar`.
- `condoservicos.sql`.
- Um `.env` apropriado para a máquina de destino.

### Ajuste do Compose no destino

Adicione a propriedade `image` ao serviço `app` em `compose.yaml`, mantendo as demais configurações:

```yaml
app:
  image: condoservicos-app:1.0
  build:
    context: .
```

### Na máquina de destino

Importe as imagens:

```powershell
docker load -i .\condoservicos-imagens.tar
```

Suba o banco sem construir imagens, restaure o dump e inicie a aplicação:

```powershell
docker compose up -d --no-build db
$db = docker compose ps -q db

docker cp .\condoservicos.sql "${db}:/tmp/condoservicos.sql"
docker exec $db sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" < /tmp/condoservicos.sql'
docker exec $db rm /tmp/condoservicos.sql

docker compose up -d --no-build app
docker compose ps
```

## Execução sem Docker

Esta opção exige que o Node.js 22 e o MySQL 8 estejam instalados localmente:

```powershell
npm install
Copy-Item .env.example .env
npm start
```

No `.env`, altere `DB_HOST` para o endereço do MySQL, por exemplo `127.0.0.1`. Sem o mapeamento Docker, a aplicação fica disponível na porta configurada em `PORT`, normalmente `http://localhost:3000/home`.

## Segurança e operação

- Senhas são armazenadas como hashes bcrypt.
- A sessão é regenerada depois da autenticação.
- Cookies de sessão usam `httpOnly` e `sameSite=strict`.
- As rotas de morador e de portaria possuem mecanismos de proteção separados.
- Consultas e atualizações usam parâmetros SQL.
- O histórico do morador é limitado pelo ID armazenado na sessão, não por parâmetros recebidos do navegador.
- A chave estrangeira de TAG impede registros de acesso para uma TAG inexistente.
- O endpoint do Event Grid usa comparação de segredo resistente a ataques de temporização e aceita somente blobs do host, container, extensão e caminho esperados.
- Arquivos de acesso são limitados a 1 MiB e 5.000 eventos; cada evento deve conter data UTC ISO 8601 e TAGID normalizada com quatro bytes.
- Eventos com TAG desconhecida ficam no histórico de importação para auditoria, sem violar a chave estrangeira da tabela final de acessos.
- A sessão padrão usa armazenamento em memória. Para produção com múltiplas instâncias, use um armazenamento de sessões persistente, como Redis ou MySQL.
- Com `NODE_ENV=production`, o cookie é marcado como seguro e requer HTTPS.
- O dump `condoservicos.sql` contém dados pessoais e hashes de senha. Trate-o como arquivo confidencial e não o publique em repositórios públicos.

## Comandos úteis

```powershell
# Estado dos serviços
docker compose ps

# Logs da aplicação
docker compose logs -f app

# Logs do MySQL
docker compose logs -f db

# Reiniciar a aplicação
docker compose restart app

# Abrir cliente MySQL no container
docker compose exec db sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
```

## Atenção ao volume do banco

O comando abaixo remove contêineres **e apaga definitivamente o volume do MySQL**:

```powershell
docker compose down -v
```

Use-o somente quando desejar reinicializar completamente o banco e possuir um backup válido.

## Bibliografia sugerida

As referências a seguir auxiliam no entendimento das tecnologias, dos serviços e das práticas de segurança empregados na solução:

- NODE.JS. [Node.js v22 documentation](https://nodejs.org/docs/latest-v22.x/api/). Referência para o ambiente de execução JavaScript e suas APIs.
- OPENJS FOUNDATION. [Express 5.x API reference](https://expressjs.com/en/5x/api.html). Documentação do framework utilizado na definição das rotas e dos middlewares da aplicação.
- EJS. [EJS documentation](https://ejs.co/). Referência para a criação das páginas HTML renderizadas no servidor.
- ORACLE. [MySQL 8.0 Reference Manual](https://dev.mysql.com/doc/refman/8.0/en/). Documentação sobre modelagem relacional, consultas SQL, índices, transações e restrições de integridade.
- DOCKER. [Docker Compose documentation](https://docs.docker.com/compose/). Referência para a definição e a execução dos serviços da aplicação e do banco de dados em contêineres.
- MICROSOFT. [Azure Blob Storage documentation](https://learn.microsoft.com/azure/storage/blobs/). Documentação sobre armazenamento de objetos, contêineres e operações com blobs.
- MICROSOFT. [Azure IoT Hub documentation](https://learn.microsoft.com/azure/iot-hub/). Referência para comunicação, gerenciamento e ingestão de dados de dispositivos IoT.
- MICROSOFT. [Azure Event Grid documentation](https://learn.microsoft.com/azure/event-grid/). Documentação sobre a distribuição de eventos utilizada para notificar a aplicação da criação de blobs.
- MICROSOFT. [Managed identities for Azure resources](https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/overview). Referência para autenticação entre serviços do Azure sem armazenamento de credenciais no código.
- OWASP FOUNDATION. [Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). Recomendações para o gerenciamento seguro de sessões e cookies em aplicações web.

**Observação:** Todos links acima encontram-se funcionais e acessíveis em 18/09/2026.

## 🧰 Tecnologias e ferramentas utilizadas

### Aplicação e interface

<p>
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript Badge"/>
  <img src="https://img.shields.io/badge/Node.js_22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 22 Badge"/>
  <img src="https://img.shields.io/badge/Express_5-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express 5 Badge"/>
  <img src="https://img.shields.io/badge/EJS_3-B4CA65?style=for-the-badge&logo=ejs&logoColor=black" alt="EJS 3 Badge"/>
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5 Badge"/>
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3 Badge"/>
</p>

### Banco de dados e contêineres

<p>
  <img src="https://img.shields.io/badge/MySQL_8-4479A1?style=for-the-badge&logo=mysql&logoColor=white" alt="MySQL 8 Badge"/>
  <img src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Badge"/>
  <img src="https://img.shields.io/badge/Docker_Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Compose Badge"/>
</p>

### Nuvem e integração IoT

<p>
  <img src="https://img.shields.io/badge/Microsoft_Azure-0078D4?style=for-the-badge&logo=microsoftazure&logoColor=white" alt="Microsoft Azure Badge"/>
  <img src="https://img.shields.io/badge/Azure_Blob_Storage-0078D4?style=for-the-badge&logo=microsoftazure&logoColor=white" alt="Azure Blob Storage Badge"/>
  <img src="https://img.shields.io/badge/Azure_IoT_Hub-0078D4?style=for-the-badge&logo=microsoftazure&logoColor=white" alt="Azure IoT Hub Badge"/>
  <img src="https://img.shields.io/badge/Azure_Event_Grid-0078D4?style=for-the-badge&logo=microsoftazure&logoColor=white" alt="Azure Event Grid Badge"/>
  <img src="https://img.shields.io/badge/Managed_Identity-0078D4?style=for-the-badge&logo=microsoftazure&logoColor=white" alt="Azure Managed Identity Badge"/>
</p>

### Controle de versão

<p>
  <img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub Badge"/>
</p>
