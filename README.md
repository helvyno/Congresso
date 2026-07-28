# Sistema de Indicadores e Assembleias — API + Painel

Aplicação com back-end real em Node/Express + PostgreSQL (Neon) e o painel de
cadastro (front-end) servido pelo mesmo servidor.

## ⚠️ Antes de tudo: sobre a senha do banco

A connection string que você compartilhou no chat já está configurada no
arquivo `.env` para facilitar o primeiro uso. Mas como ela foi digitada em
texto puro nesta conversa, o recomendado é:

1. Acessar o console da Neon (https://console.neon.tech/).
2. Resetar a senha do usuário `neondb_owner` (ou criar um novo *role*).
3. Atualizar o arquivo `.env` com a nova connection string.

O arquivo `.env` nunca deve ser enviado para um repositório público — o
`.gitignore` já está configurado para ignorá-lo.

## Estrutura

```
server/
  server.js        -> API REST (Express + pg), conecta no Postgres
  package.json
  .env              -> connection string real (não versionar)
  .env.example       -> modelo do .env, sem credenciais
  public/
    index.html       -> painel de cadastro (front-end)
```

## Como rodar

```bash
cd server
npm install
npm start
```

O servidor sobe em `http://localhost:3001` e já serve o painel em
`http://localhost:3001` (a pasta `public/` é servida como arquivos estáticos).

Se quiser rodar o front-end separado do back-end (ex.: hospedar em outro
lugar), abra `public/index.html` e ajuste a constante `API_BASE` no topo do
`<script>` para a URL onde o `server.js` está publicado, por exemplo:
```js
const API_BASE = 'https://sua-api.exemplo.com';
```

## Endpoints da API

| Método | Rota                   | Ação                          |
|--------|------------------------|-------------------------------|
| GET    | /api/:tabela           | Lista todos os registros      |
| POST   | /api/:tabela           | Cria um registro              |
| PUT    | /api/:tabela/:id       | Atualiza um registro           |
| DELETE | /api/:tabela/:id       | Remove um registro             |
| GET    | /api/health/check      | Testa a conexão com o banco    |

Tabelas disponíveis: `evento`, `setor`, `congregacao`, `privilegio`, `pessoa`,
`escalas`, `contagem` (mesmos nomes do script SQL de criação).

A integridade referencial é garantida pelo próprio Postgres: se você tentar
excluir um registro que está sendo usado em outra tabela (ex.: um Evento com
Setores vinculados), a API responde com erro 409 e uma mensagem explicando o
motivo — o painel mostra essa mensagem no toast.

## Antes de usar

Rode os scripts SQL que já criamos (criação das tabelas e inserção das
congregações) no seu banco `neondb` antes de iniciar o servidor, caso ainda
não tenha feito isso.
