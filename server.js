// =========================================================
// API REST — Sistema de Indicadores e Assembleias
// Conecta diretamente ao Postgres (Neon) usando a lib "pg".
// A connection string NUNCA fica no código: vem de process.env.DATABASE_URL
// =========================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool, types } = require('pg');

// Faz o node-postgres devolver DATE como string 'YYYY-MM-DD' (OID 1082),
// evitando o problema de fuso horário do objeto Date do JS.
types.setTypeParser(1082, val => val);

if (!process.env.DATABASE_URL) {
  console.error('ERRO: defina DATABASE_URL no arquivo .env (veja .env.example).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
const allowedOrigins = [
  'https://datasabe-app.pages.dev',   // URL que o Cloudflare Pages vai gerar
  'http://localhost:3001'              // para testes locais
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------
// Definição das tabelas permitidas (espelha o script SQL)
// Nunca aceite nome de tabela/coluna vindo direto da requisição
// sem checar contra esta lista — evita SQL injection.
// ---------------------------------------------------------
const TABLES = {
  evento:      { pk: 'codevento',      columns: ['descricao', 'data_inicio', 'data_final'] },
  congregacao: { pk: 'codcongregacao', columns: ['nome_congregacao'] },
  privilegio:  { pk: 'codprivilegio',  columns: ['descricao'] },
  setor:       { pk: 'codsetor',       columns: ['descricao', 'codevento'] },
  pessoa:      { pk: 'codpessoa',      columns: ['nomecompleto', 'telefone', 'codprivilegio', 'codevento', 'codcongregacao'] },
  escalas:     { pk: 'codescala',      columns: ['codevento', 'codpessoa', 'codsetor', 'data', 'hora_inicio', 'hora_fim'] },
  contagem:    { pk: 'codcont',        columns: ['codevento', 'codsetor', 'codpessoa', 'quantidade'] }
};

function getTableDef(name) {
  const def = TABLES[name];
  if (!def) {
    const err = new Error(`Tabela "${name}" não existe.`);
    err.status = 404;
    throw err;
  }
  return def;
}

function handleError(res, err) {
  if (err.code === '23503') {
    return res.status(409).json({ error: 'Não é possível excluir: existem registros vinculados em outra tabela.' });
  }
  if (err.code === '23502') {
    return res.status(400).json({ error: 'Existe um campo obrigatório não preenchido.' });
  }
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'Erro interno no servidor.' });
}

// ---------------------------------------------------------
// GET /api/:table -> lista todos os registros
// ---------------------------------------------------------
app.get('/api/:table', async (req, res) => {
  try {
    const def = getTableDef(req.params.table);
    const { rows } = await pool.query(`SELECT * FROM ${req.params.table} ORDER BY ${def.pk} ASC`);
    res.json(rows);
  } catch (err) { handleError(res, err); }
});

// ---------------------------------------------------------
// POST /api/:table -> cria um registro
// ---------------------------------------------------------
app.post('/api/:table', async (req, res) => {
  try {
    const table = req.params.table;
    const def = getTableDef(table);
    const cols = def.columns.filter(c => req.body[c] !== undefined);
    if (cols.length === 0) { return res.status(400).json({ error: 'Nenhum campo válido enviado.' }); }
    const values = cols.map(c => req.body[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const { rows } = await pool.query(sql, values);
    res.status(201).json(rows[0]);
  } catch (err) { handleError(res, err); }
});

// ---------------------------------------------------------
// PUT /api/:table/:id -> atualiza um registro existente
// ---------------------------------------------------------
app.put('/api/:table/:id', async (req, res) => {
  try {
    const table = req.params.table;
    const def = getTableDef(table);
    const cols = def.columns.filter(c => req.body[c] !== undefined);
    if (cols.length === 0) { return res.status(400).json({ error: 'Nenhum campo válido enviado.' }); }
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const values = cols.map(c => req.body[c]);
    values.push(req.params.id);
    const sql = `UPDATE ${table} SET ${setClause} WHERE ${def.pk} = $${values.length} RETURNING *`;
    const { rows } = await pool.query(sql, values);
    if (rows.length === 0) { return res.status(404).json({ error: 'Registro não encontrado.' }); }
    res.json(rows[0]);
  } catch (err) { handleError(res, err); }
});

// ---------------------------------------------------------
// DELETE /api/:table/:id -> remove um registro
// ---------------------------------------------------------
app.delete('/api/:table/:id', async (req, res) => {
  try {
    const table = req.params.table;
    const def = getTableDef(table);
    await pool.query(`DELETE FROM ${table} WHERE ${def.pk} = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { handleError(res, err); }
});

app.get('/api/health/check', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'conectado' });
  } catch (err) {
    res.status(500).json({ status: 'erro', database: 'desconectado' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API rodando em http://localhost:${PORT}`));
