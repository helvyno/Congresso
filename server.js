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
    
    // Tabela periodo
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

    // Tabela PARAMETROS atualizada com o campo 'ativo' e sem horários
    await client.query(`
      CREATE TABLE IF NOT EXISTS parametros (
          codparametro SERIAL PRIMARY KEY,
          datacont DATE NOT NULL,
          codperiodo INTEGER NOT NULL,
          codevento INTEGER,
          ativo BOOLEAN DEFAULT TRUE
      );
    `);
    await client.query(`ALTER TABLE parametros ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;`);
    await client.query(`ALTER TABLE parametros DROP COLUMN IF EXISTS horaini;`);
    await client.query(`ALTER TABLE parametros DROP COLUMN IF EXISTS horafim;`);

    // Tabela configmapa
    await client.query(`
      CREATE TABLE IF NOT EXISTS configmapa (
          codmapa SERIAL PRIMARY KEY,
          codevento INTEGER,
          imagem_base64 TEXT
      );
    `);

    // Atualização da tabela setor para garantir a coluna numass (caso não exista)
    await client.query(`
      CREATE TABLE IF NOT EXISTS setor (
          codsetor SERIAL PRIMARY KEY,
          descricao VARCHAR(100) NOT NULL,
          codevento INTEGER,
          numass INTEGER
      );
    `);
    await client.query(`
      ALTER TABLE setor ADD COLUMN IF NOT EXISTS numass INTEGER;
    `);
    
    client.release();
  } catch (err) {
    console.error('❌ Erro ao inicializar o banco:', err.message);
  }
}

initDatabase();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rota dedicada para salvar ou atualizar o mapa do evento sem erros
app.post('/api/configmapa/salvar', async (req, res) => {
  try {
    const { codevento, imagem_base64 } = req.body;
    if (!codevento) {
      return res.status(400).json({ error: 'Evento não especificado para o mapa.' });
    }

    const existe = await pool.query('SELECT codmapa FROM configmapa WHERE codevento = $1', [codevento]);
    
    let result;
    if (existe.rows.length > 0) {
      result = await pool.query(
        'UPDATE configmapa SET imagem_base64 = $1 WHERE codevento = $2 RETURNING *',
        [imagem_base64, codevento]
      );
    } else {
      result = await pool.query(
        'INSERT INTO configmapa (codevento, imagem_base64) VALUES ($1, $2) RETURNING *',
        [codevento, imagem_base64]
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao salvar mapa:', err.message);
    res.status(500).json({ error: 'Erro ao salvar mapa: ' + err.message });
  }
});

const TABLES = {
  evento: { pk: 'codevento', columns: ['descricao', 'data_inicio', 'data_final'] },
  setor: { pk: 'codsetor', columns: ['descricao', 'codevento', 'numass'] },
  congregacao: { pk: 'codcong', columns: ['nome_congregacao', 'codevento'] },
  privilegio: { pk: 'codprivilegio', columns: ['descricao'] },
  periodo: { pk: 'codperiodo', columns: ['descricao'] },
  pessoa: { pk: 'codpessoa', columns: ['nomecompleto', 'telefone', 'codprivilegio', 'codevento', 'codcong'] },
  escalas: { pk: 'codescala', columns: ['codevento', 'codpessoa', 'codsetor', 'data', 'hora_inicio', 'hora_fim'] },
  contagem: { pk: 'codcont', columns: ['codevento', 'codsetor', 'codpessoa', 'quantidade', 'data', 'codperiodo'] },
  usuario: { pk: 'codusuario', columns: ['nome', 'email', 'senha', 'ativo'] },
  parametros: { pk: 'codparametro', columns: ['datacont', 'codperiodo', 'codevento', 'ativo'] },
  configmapa: { pk: 'codmapa', columns: ['codevento', 'imagem_base64'] }
};

function sanitizeBody(body) {
  const sanitized = {};
  for (const key of Object.keys(body)) {
    const val = body[key];
    if (typeof val === 'string' && key !== 'imagem_base64') {
      if (key === 'email') {
        sanitized[key] = val.trim().toLowerCase();
      } else if (key === 'data' || key === 'data_inicio' || key === 'data_final' || key === 'datacont') {
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

      // Validação de CONTAGEM baseada na tabela PARAMETROS (verificando se o parâmetro está ativo para a data/período)
      if (tableName === 'contagem') {
        const { data, codperiodo, codevento } = cleanBody;

        const paramQuery = await pool.query(
          `SELECT * FROM parametros WHERE datacont = $1 AND codperiodo = $2 AND (codevento = $3 OR codevento IS NULL) AND ativo = true`,
          [data, codperiodo, codevento]
        );

        if (paramQuery.rows.length === 0) {
          return res.status(400).json({ 
            error: 'Contagem não Liberada, aguarde liberação da Mesa' 
          });
        }
      }

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
        errMsg = 'Já existe um registro duplicado com esses dados.';
      }
      res.status(400).json({ error: errMsg });
    }
  });

  app.put(`/api/${tableName}/:id`, async (req, res) => {
    try {
      const { id } = req.params;
      const cleanBody = sanitizeBody(req.body);

      // Validação de CONTAGEM no UPDATE também
      if (tableName === 'contagem') {
        const { data, codperiodo, codevento } = cleanBody;
        const paramQuery = await pool.query(
          `SELECT * FROM parametros WHERE datacont = $1 AND codperiodo = $2 AND (codevento = $3 OR codevento IS NULL) AND ativo = true`,
          [data, codperiodo, codevento]
        );

        if (paramQuery.rows.length === 0) {
          return res.status(400).json({ 
            error: 'Contagem não Liberada, aguarde liberação da Mesa' 
          });
        }
      }

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
        errMsg = 'Já existe um registro duplicado com esses dados.';
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