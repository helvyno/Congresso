const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Rota de Health Check
app.get('/api/health/check', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Mapeamento correto das chaves primárias de cada tabela (sem inventar colunas)
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
  usuario: 'codusuario',
  configmapa: 'codmapa',
  listapresenca: 'codpresenca'
};

const entities = [
  'evento', 'setor', 'congregacao', 'privilegio', 'periodo', 
  'perfil', 'parametros', 'pessoa', 'escalas', 'contagem', 
  'usuario', 'configmapa', 'pessoadisponibilidade', 'listapresenca'
];

entities.forEach(table => {
  const pk = pkMap[table] || 'id';

  // GET: Listar todos
  app.get(`/api/${table}`, async (req, res) => {
    try {
      let query = `SELECT * FROM ${table}`;
      if (pkMap[table]) {
        query += ` ORDER BY ${pk} ASC`;
      }
      const result = await pool.query(query);
      res.json(result.rows);
    } catch (err) {
      console.error(`Erro ao listar ${table}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST: Criar registro
  app.post(`/api/${table}`, async (req, res) => {
    const data = req.body;
    const keys = Object.keys(data);
    const values = Object.values(data);
    
    if (keys.length === 0) {
      return res.status(400).json({ error: 'Nenhum dado enviado para inserção.' });
    }

    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const query = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;

    try {
      const result = await pool.query(query, values);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error(`Erro ao inserir em ${table}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: Atualizar registro (Apenas para tabelas que possuem chave primária padrão)
  if (pkMap[table]) {
    app.put(`/api/${table}/:id`, async (req, res) => {
      const { id } = req.params;
      const data = req.body;
      const keys = Object.keys(data);
      const values = Object.values(data);

      if (keys.length === 0) {
        return res.status(400).json({ error: 'Nenhum dado enviado para atualização.' });
      }

      const setString = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      const query = `UPDATE ${table} SET ${setString} WHERE ${pk} = $${keys.length + 1} RETURNING *`;

      try {
        const result = await pool.query(query, [...values, id]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Registro não encontrado.' });
        }
        res.json(result.rows[0]);
      } catch (err) {
        console.error(`Erro ao atualizar ${table}:`, err);
        res.status(500).json({ error: err.message });
      }
    });

    // DELETE: Excluir registro
    app.delete(`/api/${table}/:id`, async (req, res) => {
      const { id } = req.params;
      try {
        const result = await pool.query(`DELETE FROM ${table} WHERE ${pk} = $1 RETURNING *`, [id]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Registro não encontrado.' });
        }
        res.status(204).send();
      } catch (err) {
        console.error(`Erro ao excluir de ${table}:`, err);
        res.status(500).json({ error: err.message });
      }
    });
  }
});

// Rota específica para salvar Lista de Presença em lote
app.post('/api/listapresenca/salvar', async (req, res) => {
  const { codpessoa, presencas } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    await client.query('DELETE FROM listapresenca WHERE codpessoa = $1', [codpessoa]);

    if (presencas && Array.isArray(presencas)) {
      for (const p of presencas) {
        await client.query(
          'INSERT INTO listapresenca (codpessoa, codevento, data, presente) VALUES ($1, $2, $3, $4)',
          [p.codpessoa, p.codevento, p.data, p.presente]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar presença:', err);
    res.status(500).json({ error: 'Erro ao salvar presença: ' + err.message });
  } finally {
    client.release();
  }
});

// Rota específica para salvar o mapa em Base64 usando codmapa
app.post('/api/configmapa/salvar', async (req, res) => {
  const { codevento, imagem_base64 } = req.body;
  try {
    const check = await pool.query('SELECT codmapa FROM configmapa WHERE codevento = $1', [codevento]);
    let result;
    if (check.rows.length > 0) {
      result = await pool.query(
        'UPDATE configmapa SET imagem_base64 = $1 WHERE codevento = $2 RETURNING *',
        [imagem_base64, codevento]
      );
    } else {
      result = await pool.query(
        'INSERT INTO configmapa (codevento, imagem_base64) VALUES ($1, $2) RETURNING *',
        [codevento, codevento]
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao salvar mapa:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rota específica para salvar disponibilidade em lote (sem depender de codpessoadisp)
app.post('/api/pessoadisponibilidade/salvar', async (req, res) => {
  const { codpessoa, disponibilidades } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM pessoadisponibilidade WHERE codpessoa = $1', [codpessoa]);

    if (disponibilidades && Array.isArray(disponibilidades)) {
      for (const d of disponibilidades) {
        await client.query(
          'INSERT INTO pessoadisponibilidade (codpessoa, codevento, data, codperiodo) VALUES ($1, $2, $3, $4)',
          [d.codpessoa, d.codevento, d.data, d.codperiodo]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar disponibilidade:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});