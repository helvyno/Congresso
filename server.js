// =========================================================
// API REST — DATASABE Sistema de Designação de Indicadores
// Conecta diretamente ao Postgres (Neon) usando a lib "pg".
// =========================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool, types } = require('pg');

types.setTypeParser(1082, val => val);

if (!process.env.DATABASE_URL) {
  console.error('ERRO: defina DATABASE_URL no arquivo .env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(client => {
    console.log('✅ Conectado ao Neon PostgreSQL');
    client.release();
  })
  .catch(err => {
    console.error('❌ Erro ao conectar ao Neon:', err.message);
  });

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TABLES = {
  evento: { pk: 'codevento', columns: ['descricao', 'data_inicio', 'data_final'] },
  setor: { pk: 'codsetor', columns: ['descricao', 'codevento'] },
  congregacao: { pk: 'codcong', columns: ['nome_congregacao', 'codevento'] },
  privilegio: { pk: 'codprivilegio', columns: ['descricao'] },
  pessoa: { pk: 'codpessoa', columns: ['nomecompleto', 'telefone', 'codprivilegio', 'codevento', 'codcong'] },
  escalas: { pk: 'codescala', columns: ['codevento', 'codpessoa', 'codsetor', 'data', 'hora_inicio', 'hora_fim'] },
  contagem: { pk: 'codcont', columns: ['codevento', 'codsetor', 'codpessoa', 'quantidade'] },
  usuario: { pk: 'codusuario', columns: ['nome', 'email', 'senha', 'ativo'] }
};

app.get('/api/health/check', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

Object.keys(TABLES).forEach(tableName => {
  const cfg = TABLES[tableName];

  app.get(`/api/${tableName}`, async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM ${tableName} ORDER BY ${cfg.pk} ASC`);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get(`/api/${tableName}/:id`, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(`SELECT * FROM ${tableName} WHERE ${cfg.pk} = $1`, [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(`/api/${tableName}`, async (req, res) => {
    try {
      const cols = cfg.columns;
      const values = cols.map(c => req.body[c] !== undefined ? req.body[c] : null);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

      const query = `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`;
      const result = await pool.query(query, values);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put(`/api/${tableName}/:id`, async (req, res) => {
    try {
      const { id } = req.params;
      const cols = cfg.columns;
      const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const values = cols.map(c => req.body[c] !== undefined ? req.body[c] : null);
      values.push(id);

      const query = `UPDATE ${tableName} SET ${setClause} WHERE ${cfg.pk} = $${values.length} RETURNING *`;
      const result = await pool.query(query, values);

      if (result.rows.length === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete(`/api/${tableName}/:id`, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(`DELETE FROM ${tableName} WHERE ${cfg.pk} = $1 RETURNING *`, [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
      res.status(204).send();
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});