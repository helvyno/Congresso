require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Configuração da conexão com o banco de dados (Neon / PostgreSQL) com SSL e dotenv
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS evento (
        codevento SERIAL PRIMARY KEY,
        descricao TEXT NOT NULL,
        data_inicio DATE NOT NULL,
        data_final DATE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS setor (
        codsetor SERIAL PRIMARY KEY,
        descricao TEXT NOT NULL,
        codevento INT REFERENCES evento(codevento) ON DELETE CASCADE,
        numass INT
      );

      CREATE TABLE IF NOT EXISTS congregacao (
        codcong SERIAL PRIMARY KEY,
        nome_congregacao TEXT NOT NULL,
        codevento INT REFERENCES evento(codevento) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS privilegio (
        codprivilegio SERIAL PRIMARY KEY,
        descricao TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS periodo (
        codperiodo SERIAL PRIMARY KEY,
        descricao TEXT NOT NULL,
        horario_inicial TIME,
        horario_final TIME
      );

      CREATE TABLE IF NOT EXISTS parametros (
        codparametro SERIAL PRIMARY KEY,
        codevento INT REFERENCES evento(codevento) ON DELETE CASCADE,
        datacont DATE NOT NULL,
        horacont TIME,
        codperiodo INT REFERENCES periodo(codperiodo),
        ativo BOOLEAN DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS pessoa (
        codpessoa SERIAL PRIMARY KEY,
        nomecompleto TEXT NOT NULL,
        telefone TEXT,
        codprivilegio INT REFERENCES privilegio(codprivilegio),
        codevento INT REFERENCES evento(codevento) ON DELETE CASCADE,
        codcong INT REFERENCES congregacao(codcong)
      );

      CREATE TABLE IF NOT EXISTS escalas (
        codescala SERIAL PRIMARY KEY,
        codevento INT REFERENCES evento(codevento) ON DELETE CASCADE,
        codpessoa INT REFERENCES pessoa(codpessoa) ON DELETE CASCADE,
        codsetor INT REFERENCES setor(codsetor) ON DELETE CASCADE,
        codperiodo INT REFERENCES periodo(codperiodo),
        data DATE NOT NULL,
        hora_inicio TIME NOT NULL,
        hora_fim TIME NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contagem (
        codcont SERIAL PRIMARY KEY,
        codevento INT REFERENCES evento(codevento) ON DELETE CASCADE,
        data DATE NOT NULL,
        codperiodo INT REFERENCES periodo(codperiodo),
        codsetor INT REFERENCES setor(codsetor) ON DELETE CASCADE,
        codpessoa INT REFERENCES pessoa(codpessoa) ON DELETE CASCADE,
        quantidade INT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usuario (
        codusuario SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        email TEXT NOT NULL,
        senha TEXT NOT NULL,
        ativo BOOLEAN DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS configmapa (
        codmapa SERIAL PRIMARY KEY,
        codevento INT REFERENCES evento(codevento) ON DELETE CASCADE,
        imagem_base64 TEXT
      );
    `);
    console.log("Banco de dados inicializado com sucesso.");
  } catch (err) {
    console.error("Erro ao inicializar o banco de dados:", err);
  } finally {
    client.release();
  }
}

app.get('/api/health/check', (req, res) => {
  res.json({ status: 'ok' });
});

const entities = ['evento', 'setor', 'congregacao', 'privilegio', 'periodo', 'parametros', 'pessoa', 'escalas', 'contagem', 'usuario', 'configmapa'];

entities.forEach(table => {
  const pkMap = {
    evento: 'codevento',
    setor: 'codsetor',
    congregacao: 'codcong',
    privilegio: 'codprivilegio',
    periodo: 'codperiodo',
    parametros: 'codparametro',
    pessoa: 'codpessoa',
    escalas: 'codescala',
    contagem: 'codcont',
    usuario: 'codusuario',
    configmapa: 'codmapa'
  };
  const pk = pkMap[table];

  app.get(`/api/${table}`, async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM ${table} ORDER BY ${pk} ASC`);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(`/api/${table}`, async (req, res) => {
    try {
      const keys = Object.keys(req.body);
      const values = Object.values(req.body);
      if (keys.length === 0) {
        return res.status(400).json({ error: 'Nenhum dado fornecido.' });
      }
      const indicators = keys.map((_, i) => `$${i + 1}`).join(', ');
      const query = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${indicators}) RETURNING *`;
      const result = await pool.query(query, values);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put(`/api/${table}/:id`, async (req, res) => {
    try {
      const id = req.params.id;
      const keys = Object.keys(req.body);
      const values = Object.values(req.body);
      if (keys.length === 0) {
        return res.status(400).json({ error: 'Nenhum dado fornecido.' });
      }
      const setString = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      values.push(id);
      const query = `UPDATE ${table} SET ${setString} WHERE ${pk} = $${values.length} RETURNING *`;
      const result = await pool.query(query, values);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Registro não encontrado.' });
      }
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete(`/api/${table}/:id`, async (req, res) => {
    try {
      const id = req.params.id;
      const result = await pool.query(`DELETE FROM ${table} WHERE ${pk} = $1 RETURNING *`, [id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Registro não encontrado.' });
      }
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

app.post('/api/configmapa/salvar', async (req, res) => {
  try {
    const { codevento, imagem_base64 } = req.body;
    const existe = await pool.query('SELECT * FROM configmapa WHERE codevento = $1', [codevento]);
    let result;
    if (existe.rows.length > 0) {
      result = await pool.query('UPDATE configmapa SET imagem_base64 = $1 WHERE codevento = $2 RETURNING *', [imagem_base64, codevento]);
    } else {
      result = await pool.query('INSERT INTO configmapa (codevento, imagem_base64) VALUES ($1, $2) RETURNING *', [codevento, imagem_base64]);
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Servidor rodando na porta ${PORT}`);
});