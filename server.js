const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Configurar o Express para servir os arquivos estáticos
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

// Rotas de Lista de Presença
app.get('/api/listapresenca', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listapresenca ORDER BY codpresenca ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/listapresenca', async (req, res) => {
  const { codpessoa, codevento, data, presente } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO listapresenca (codpessoa, codevento, data, presente) VALUES ($1, $2, $3, $4) RETURNING *',
      [codpessoa, codevento, data, presente !== undefined ? presente : true]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/listapresenca/:id', async (req, res) => {
  const id = req.params.id;
  const { codpessoa, codevento, data, presente } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE listapresenca SET codpessoa = $1, codevento = $2, data = $3, presente = $4 WHERE codpresenca = $5 RETURNING *',
      [codpessoa, codevento, data, presente, id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/listapresenca/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await pool.query('DELETE FROM listapresenca WHERE codpresenca = $1', [id]);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rotas genéricas para as demais tabelas do sistema
const tables = [
  'evento', 'setor', 'congregacao', 'privilegio', 
  'periodo', 'perfil', 'parametros', 'pessoa', 
  'escalas', 'contagem'
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
      if (err.message.includes('uk_contagem_evento_data_periodo_setor') || err.message.includes('duplicate key')) {
        res.status(400).json({ error: 'Já existe uma contagem registrada para este setor nesta data e período.' });
      } else {
        res.status(500).json({ error: err.message });
      }
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
      if (err.message.includes('uk_contagem_evento_data_periodo_setor') || err.message.includes('duplicate key')) {
        res.status(400).json({ error: 'Já existe uma contagem registrada para este setor nesta data e período.' });
      } else {
        res.status(500).json({ error: err.message });
      }
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

// Usuários são independentes de Pessoas. O login é a chave lógica do acesso;
// por isso a API não permite replicações do mesmo usuário e retorna apenas
// o registro mais recente quando a base já contém duplicidades históricas.
app.get('/api/usuario', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (LOWER(TRIM(login))) *
      FROM usuario
      ORDER BY LOWER(TRIM(login)), codusuario DESC
    `);
    rows.sort((a, b) => Number(a.codusuario) - Number(b.codusuario));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/usuario', async (req, res) => {
  const data = { ...req.body };
  if (data.login !== undefined && data.login !== null) {
    data.login = String(data.login).replace(/\\D/g, '');
  }
  const keys = Object.keys(data);
  const values = Object.values(data);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  try {
    const duplicate = await pool.query(
      'SELECT codusuario FROM usuario WHERE LOWER(TRIM(login)) = LOWER(TRIM($1)) LIMIT 1',
      [data.login]
    );
    if (duplicate.rows.length) {
      return res.status(409).json({ error: 'Este login já está cadastrado na tabela de usuários.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO usuario (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/usuario/:id', async (req, res) => {
  const id = req.params.id;
  const data = { ...req.body };
  if (data.login !== undefined && data.login !== null) {
    data.login = String(data.login).replace(/\\D/g, '');
  }
  const keys = Object.keys(data);
  const values = Object.values(data);
  const setString = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
  try {
    const duplicate = await pool.query(
      'SELECT codusuario FROM usuario WHERE LOWER(TRIM(login)) = LOWER(TRIM($1)) AND codusuario <> $2 LIMIT 1',
      [data.login, id]
    );
    if (duplicate.rows.length) {
      return res.status(409).json({ error: 'Este login já está cadastrado na tabela de usuários.' });
    }
    const { rows } = await pool.query(
      `UPDATE usuario SET ${setString} WHERE codusuario = $${keys.length + 1} RETURNING *`,
      [...values, id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/usuario/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM usuario WHERE codusuario = $1', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Módulo BI: relatórios SQL personalizados, sempre restritos a consultas de leitura.
// A estrutura da tabela relatorios_bi está no arquivo sql/criar_relatorios_bi.sql.

function validateBiSql(sql) {
  const normalized = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!normalized) throw new Error('Informe a consulta SQL.');
  if (normalized.includes(';')) throw new Error('Informe apenas uma instrução SQL por relatório.');
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error('Por segurança, os relatórios BI aceitam apenas consultas SELECT ou WITH.');
  }
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|call|do)\b/i.test(normalized)) {
    throw new Error('A consulta contém uma operação não permitida.');
  }
  return normalized;
}

app.get('/api/bi', async (req, res) => {
  try {
    const codevento = Number(req.query.codevento);
    if (!Number.isInteger(codevento) || codevento <= 0) return res.status(400).json({ error: 'Informe um evento válido para carregar os relatórios BI.' });
    const { rows } = await pool.query('SELECT id, codevento, nome, descricao, sql_consulta, ativo, criado_em, atualizado_em FROM relatorios_bi WHERE codevento = $1 ORDER BY nome ASC, id ASC', [codevento]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bi', async (req, res) => {
  try {
    const { codevento, nome, descricao, sql_consulta, ativo = true } = req.body || {};
    const eventId = Number(codevento);
    const sql = validateBiSql(sql_consulta);
    if (!Number.isInteger(eventId) || eventId <= 0) return res.status(400).json({ error: 'Selecione um evento válido para o relatório.' });
    if (!String(nome || '').trim()) return res.status(400).json({ error: 'Informe o nome do relatório.' });
    const { rows } = await pool.query(
      'INSERT INTO relatorios_bi (codevento, nome, descricao, sql_consulta, ativo) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [eventId, String(nome).trim(), descricao || null, sql, ativo !== false]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/bi/:id', async (req, res) => {
  try {
    const { codevento, nome, descricao, sql_consulta, ativo = true } = req.body || {};
    const eventId = Number(codevento);
    const sql = validateBiSql(sql_consulta);
    if (!Number.isInteger(eventId) || eventId <= 0) return res.status(400).json({ error: 'Selecione um evento válido para o relatório.' });
    if (!String(nome || '').trim()) return res.status(400).json({ error: 'Informe o nome do relatório.' });
    const { rows } = await pool.query(
      'UPDATE relatorios_bi SET codevento = $1, nome = $2, descricao = $3, sql_consulta = $4, ativo = $5, atualizado_em = NOW() WHERE id = $6 RETURNING *',
      [eventId, String(nome).trim(), descricao || null, sql, ativo !== false, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Relatório BI não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/bi/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM relatorios_bi WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Relatório BI não encontrado.' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bi/executar', async (req, res) => {
  try {
    const { codevento, nome, sql_consulta } = req.body || {};
    const eventId = Number(codevento);
    if (!Number.isInteger(eventId) || eventId <= 0) return res.status(400).json({ error: 'Selecione um evento válido para executar a consulta.' });
    const sql = validateBiSql(sql_consulta);
    const result = await pool.query({ text: sql, values: [], rowMode: 'array' });
    res.json({ nome: String(nome || 'Consulta BI'), columns: result.fields.map(field => field.name), rows: result.rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/bi/:id/executar', async (req, res) => {
  try {
    const eventId = Number(req.body && req.body.codevento);
    if (!Number.isInteger(eventId) || eventId <= 0) return res.status(400).json({ error: 'Selecione um evento válido para executar a consulta.' });
    const report = await pool.query('SELECT id, nome, sql_consulta, ativo FROM relatorios_bi WHERE id = $1 AND codevento = $2', [req.params.id, eventId]);
    if (!report.rows.length) return res.status(404).json({ error: 'Relatório BI não encontrado.' });
    if (!report.rows[0].ativo) return res.status(400).json({ error: 'Este relatório está inativo.' });
    const sql = validateBiSql(report.rows[0].sql_consulta);
    const result = await pool.query({ text: sql, values: [], rowMode: 'array' });
    res.json({ nome: report.rows[0].nome, columns: result.fields.map(field => field.name), rows: result.rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});