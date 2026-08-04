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

async function initDatabase() {
  try {
    const client = await pool.connect();
    console.log('✅ Conectado ao Neon PostgreSQL');
    
    // Garante que a tabela periodo existe e possui os registros padrão caso esteja vazia
    await client.query(`
      CREATE TABLE IF NOT EXISTS periodo (
          codperiodo SERIAL PRIMARY KEY,
          descricao VARCHAR(50) NOT NULL
      );
    `);
    const resPeriodo = await client.query('SELECT COUNT(*) FROM periodo');
    if (parseInt(resPeriodo.rows[0].count) === 0) {
      await client.query("INSERT INTO periodo (descricao) VALUES ('MANHÃ'), ('TARDE');");
      console.log('✨ Períodos padrão (MANHÃ, TARDE) inseridos com sucesso!');
    }
    
    client.release();
  } catch (err) {
    console.error('❌ Erro ao inicializar o banco:', err.message);
  }
}

initDatabase();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TABLES = {
  evento: { pk: 'codevento', columns: ['descricao', 'data_inicio', 'data_final'] },
  setor: { pk: 'codsetor', columns: ['descricao', 'codevento'] },
  congregacao: { pk: 'codcong', columns: ['nome_congregacao', 'codevento'] },
  privilegio: { pk: 'codprivilegio', columns: ['descricao'] },
  periodo: { pk: 'codperiodo', columns: ['descricao'] },
  pessoa: { pk: 'codpessoa', columns: ['nomecompleto', 'telefone', 'codprivilegio', 'codevento', 'codcong'] },
  escalas: { pk: 'codescala', columns: ['codevento', 'codpessoa', 'codsetor', 'data', 'hora_inicio', 'hora_fim'] },
  contagem: { pk: 'codcont', columns: ['codevento', 'codsetor', 'codpessoa', 'quantidade', 'data', 'codperiodo'] },
  usuario: { pk: 'codusuario', columns: ['nome', 'email', 'senha', 'ativo'] }
};

function sanitizeBody(body) {
  const sanitized = {};
  for (const key of Object.keys(body)) {
    const val = body[key];
    if (typeof val === 'string') {
      if (key === 'email') {
        sanitized[key] = val.trim().toLowerCase();
      } else if (key === 'data' || key === 'data_inicio' || key === 'data_final') {
        sanitized[key] = val;
      } else {
        sanitized[key] = val.trim().toUpperCase();
      }
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

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
      console.error(`Erro GET /api/${tableName}:`, err.message);
      res.status(500).json({ error: `Erro na tabela ${tableName}: ${err.message}` });
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
      const cleanBody = sanitizeBody(req.body);
      const cols = cfg.columns;
      const values = cols.map(c => cleanBody[c] !== undefined ? cleanBody[c] : null);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

      const query = `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`;
      const result = await pool.query(query, values);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error(`Erro no POST /api/${tableName}:`, err.message);
      let errMsg = err.message;
      if (err.code === '23505') {
        errMsg = 'Já existe uma contagem cadastrada para este Setor, Período e Data neste Evento.';
      }
      res.status(400).json({ error: errMsg });
    }
  });

  app.put(`/api/${tableName}/:id`, async (req, res) => {
    try {
      const { id } = req.params;
      const cleanBody = sanitizeBody(req.body);
      const cols = cfg.columns;
      const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const values = cols.map(c => cleanBody[c] !== undefined ? cleanBody[c] : null);
      values.push(id);

      const query = `UPDATE ${tableName} SET ${setClause} WHERE ${cfg.pk} = $${values.length} RETURNING *`;
      const result = await pool.query(query, values);

      if (result.rows.length === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
      res.json(result.rows[0]);
    } catch (err) {
      let errMsg = err.message;
      if (err.code === '23505') {
        errMsg = 'Já existe uma contagem cadastrada para este Setor, Período e Data neste Evento.';
      }
      res.status(400).json({ error: errMsg });
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