const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Configurar o Express para servir os arquivos estáticos (index.html, logo.jpg, fundo.jpg, etc.) da pasta atual
app.use(express.static(path.join(__dirname)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Health check endpoint
app.get('/api/health/check', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Configuração do Mapa do Evento
app.get('/api/configmapa', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM configmapa');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/configmapa/salvar', async (req, res) => {
  const { codevento, imagem_base64 } = req.body;
  try {
    await pool.query('DELETE FROM configmapa WHERE codevento = $1', [codevento]);
    const { rows } = await pool.query(
      'INSERT INTO configmapa (codevento, imagem_base64) VALUES ($1, $2) RETURNING *',
      [codevento, imagem_base64]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rotas de Disponibilidade de Pessoas
app.get('/api/pessoadisponibilidade', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pessoadisponibilidade');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pessoadisponibilidade/salvar', async (req, res) => {
  const { codpessoa, disponibilidades } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM pessoadisponibilidade WHERE codpessoa = $1', [codpessoa]);
    
    for (const d of disponibilidades) {
      await client.query(
        'INSERT INTO pessoadisponibilidade (codpessoa, codevento, data, codperiodo) VALUES ($1, $2, $3, $4)',
        [d.codpessoa, d.codevento, d.data, d.codperiodo]
      );
    }
    await client.query('COMMIT');
    res.json({ status: 'ok' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Rotas genéricas para as demais tabelas do sistema
const tables = [
  'evento', 'setor', 'congregacao', 'privilegio', 
  'periodo', 'perfil', 'parametros', 'pessoa', 
  'escalas', 'contagem', 'usuario'
];

tables.forEach(table => {
  const pkMap = {
    evento: 'codevento',
    setor: 'codsetor',
    congregacao: 'codcong',
    privilegio: 'codprivilegio',
    periodo: 'codperiodo',
    perfil: 'codperfil',
    parametros: 'codparametro',
    pessoa: 'codpessoa',
    escalas: 'codescala',
    contagem: 'codcont',
    usuario: 'codusuario'
  };
  const pk = pkMap[table];

  app.get(`/api/${table}`, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY ${pk} ASC`);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(`/api/${table}`, async (req, res) => {
    const data = req.body;
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const query = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    try {
      const { rows } = await pool.query(query, values);
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put(`/api/${table}/:id`, async (req, res) => {
    const id = req.params.id;
    const data = req.body;
    const keys = Object.keys(data);
    const values = Object.values(data);
    const setString = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const query = `UPDATE ${table} SET ${setString} WHERE ${pk} = $${keys.length + 1} RETURNING *`;
    try {
      const { rows } = await pool.query(query, [...values, id]);
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete(`/api/${table}/:id`, async (req, res) => {
    const id = req.params.id;
    try {
      await pool.query(`DELETE FROM ${table} WHERE ${pk} = $1`, [id]);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});