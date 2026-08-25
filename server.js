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


function normalizeIdentity(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

app.post('/api/autenticar', async (req, res) => {
  try {
    const codevento = Number(req.body?.codevento);
    const usuario = normalizeIdentity(req.body?.usuario);
    if (!Number.isInteger(codevento) || codevento <= 0 || !usuario) return res.status(400).json({ error: 'Informe um evento e um usuário válidos.' });
    const { rows } = await pool.query(`
      SELECT p.*, pf.descricao AS perfil_descricao
      FROM pessoa p
      LEFT JOIN perfil pf ON pf.codperfil = p.codperfil
      WHERE p.codevento = $1
    `, [codevento]);
    const pessoa = rows.find(row => normalizeIdentity(row.usuario) === usuario);
    if (!pessoa) return res.status(401).json({ error: 'Usuário não encontrado ou sem acesso a este evento.' });
    res.json({ pessoa, perfil: pessoa.perfil_descricao || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const { codevento } = req.query;
    const query = codevento
      ? { text: 'SELECT * FROM pessoadisponibilidade WHERE codevento = $1 ORDER BY codpessoa ASC, data ASC, codperiodo ASC', values: [codevento] }
      : { text: 'SELECT * FROM pessoadisponibilidade ORDER BY codpessoa ASC, data ASC, codperiodo ASC', values: [] };
    const { rows } = await pool.query(query);
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
    const codevento = disponibilidades.length > 0 ? disponibilidades[0].codevento : req.body.codevento;
    if (!codevento) throw new Error('O evento da disponibilidade é obrigatório.');
    await client.query('DELETE FROM pessoadisponibilidade WHERE codpessoa = $1 AND codevento = $2', [codpessoa, codevento]);
    
    for (const d of disponibilidades) {
      await client.query(
        'INSERT INTO pessoadisponibilidade (codpessoa, codevento, data, codperiodo) VALUES ($1, $2, $3, $4)',
        [d.codpessoa || codpessoa, d.codevento || codevento, d.data, d.codperiodo]
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
    try {
      const data = { ...req.body };
    if (table === 'pessoa') {
      data.usuario = String(data.usuario || '').trim().toUpperCase();
      if (!data.usuario) return res.status(400).json({ error: 'O usuário é obrigatório.' });
      const duplicate = await pool.query('SELECT codpessoa FROM pessoa WHERE UPPER(TRIM(usuario)) = $1 LIMIT 1', [data.usuario]);
      if (duplicate.rows.length) return res.status(409).json({ error: 'Usuário já existe, informe um usuário diferente' });
    }
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const query = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
      const { rows } = await pool.query(query, values);
      res.status(201).json(rows[0]);
    } catch (err) {
      if (table === 'pessoa' && (err.code === '23505' || err.message.includes('usuario'))) {
        res.status(409).json({ error: 'Usuário já existe, informe um usuário diferente' });
      } else if (err.message.includes('uk_contagem_evento_data_periodo_setor') || err.message.includes('duplicate key')) {
        res.status(400).json({ error: 'Já existe uma contagem registrada para este setor nesta data e período.' });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  app.put(`/api/${table}/:id`, async (req, res) => {
    try {
      const id = req.params.id;
      const data = { ...req.body };
    if (table === 'pessoa') {
      data.usuario = String(data.usuario || '').trim().toUpperCase();
      if (!data.usuario) return res.status(400).json({ error: 'O usuário é obrigatório.' });
      const duplicate = await pool.query('SELECT codpessoa FROM pessoa WHERE UPPER(TRIM(usuario)) = $1 AND codpessoa <> $2 LIMIT 1', [data.usuario, id]);
      if (duplicate.rows.length) return res.status(409).json({ error: 'Usuário já existe, informe um usuário diferente' });
    }
    const keys = Object.keys(data);
    const values = Object.values(data);
    const setString = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const query = `UPDATE ${table} SET ${setString} WHERE ${pk} = $${keys.length + 1} RETURNING *`;
      const { rows } = await pool.query(query, [...values, id]);
      res.json(rows[0]);
    } catch (err) {
      if (table === 'pessoa' && (err.code === '23505' || err.message.includes('usuario'))) {
        res.status(409).json({ error: 'Usuário já existe, informe um usuário diferente' });
      } else if (err.message.includes('uk_contagem_evento_data_periodo_setor') || err.message.includes('duplicate key')) {
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

// Replicação seletiva de dados ao criar um novo evento.
const EVENT_REPLICATION_DEFINITIONS = {
  setor: { pk: 'codsetor', columns: ['descricao', 'numass', 'codevento'], dependencies: [] },
  congregacao: { pk: 'codcong', columns: ['nome_congregacao', 'codevento'], dependencies: [] },
  parametros: { pk: 'codparametro', columns: ['codevento', 'datacont', 'horacont', 'codperiodo', 'ativo'], dependencies: [] },
  pessoa: { pk: 'codpessoa', columns: ['nomecompleto', 'telefone', 'usuario', 'codprivilegio', 'codperfil', 'codevento', 'codcong'], dependencies: ['congregacao'] },
  escalas: { pk: 'codescala', columns: ['codevento', 'data', 'codperiodo', 'codpessoa', 'codsetor', 'hora_inicio', 'hora_fim'], dependencies: ['pessoa', 'setor'] },
  contagem: { pk: 'codcont', columns: ['codevento', 'data', 'codperiodo', 'codsetor', 'codpessoa', 'quantidade'], dependencies: ['pessoa', 'setor'] },
  listapresenca: { pk: 'codpresenca', columns: ['codpessoa', 'codevento', 'data', 'presente'], dependencies: ['pessoa'] },
  pessoadisponibilidade: { pk: null, columns: ['codpessoa', 'codevento', 'data', 'codperiodo'], dependencies: ['pessoa'] },
  configmapa: { pk: null, columns: ['codevento', 'imagem_base64'], dependencies: [] },
  relatorios_bi: { pk: 'id', columns: ['codevento', 'nome', 'descricao', 'sql_consulta', 'ativo'], dependencies: [] }
};

async function validarSenhaMestre(client, senha) {
  const password = String(senha || '');
  if (!password) return false;
  const result = await client.query(`
    SELECT senha
    FROM usuario
    WHERE (ativo IS NULL OR LOWER(TRIM(CAST(ativo AS TEXT))) IN ('true', '1', 'sim', 's'))
      AND (UPPER(TRIM(nome)) LIKE '%ADMIN%' OR LOWER(TRIM(login)) IN ('admin', 'administrador'))
      AND senha IS NOT NULL
  `);
  return result.rows.some(row => String(row.senha) === password);
}

function validarTabelasReplicacao(selectedTables) {
  const requested = [...new Set((Array.isArray(selectedTables) ? selectedTables : []).map(String))];
  const invalid = requested.filter(table => !EVENT_REPLICATION_DEFINITIONS[table]);
  if (invalid.length) throw new Error(`Tabela não autorizada para replicação: ${invalid.join(', ')}`);
  for (const table of requested) {
    const missing = EVENT_REPLICATION_DEFINITIONS[table].dependencies.filter(dep => !requested.includes(dep));
    if (missing.length) throw new Error(`Para replicar ${table}, selecione também: ${missing.join(', ')}.`);
  }
  return requested;
}

app.post('/api/evento/replicar', async (req, res) => {
  const { sourceCodevento, targetCodevento, tables: selectedTables, masterPassword } = req.body || {};
  const sourceId = Number(sourceCodevento);
  const targetId = Number(targetCodevento);
  let tablesToCopy;
  try {
    if (!Number.isInteger(sourceId) || !Number.isInteger(targetId) || sourceId <= 0 || targetId <= 0 || sourceId === targetId) {
      return res.status(400).json({ error: 'Informe eventos de origem e destino válidos e diferentes.' });
    }
    const requestedTables = validarTabelasReplicacao(selectedTables);
    if (!requestedTables.length) return res.status(400).json({ error: 'Selecione ao menos uma tabela para replicar.' });
    const replicationOrder = ['congregacao', 'setor', 'parametros', 'pessoa', 'escalas', 'contagem', 'listapresenca', 'pessoadisponibilidade', 'configmapa', 'relatorios_bi'];
    tablesToCopy = replicationOrder.filter(table => requestedTables.includes(table));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const eventCheck = await client.query('SELECT codevento FROM evento WHERE codevento IN ($1, $2)', [sourceId, targetId]);
      if (eventCheck.rows.length !== 2) throw new Error('Evento de origem ou destino não foi encontrado.');
      if (!await validarSenhaMestre(client, masterPassword)) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Senha mestre inválida.' });
      }

      const mappings = {};
      const copied = {};
      for (const table of tablesToCopy) {
        const def = EVENT_REPLICATION_DEFINITIONS[table];
        const sourceRows = await client.query(`SELECT * FROM ${table} WHERE codevento = $1 ORDER BY ${def.pk || 'codevento'} ASC`, [sourceId]);
        mappings[table] = new Map();
        copied[table] = 0;

        for (const sourceRow of sourceRows.rows) {
          const values = def.columns.map(column => {
            if (column === 'codevento') return targetId;
            if (column === 'codcong' && mappings.congregacao) return mappings.congregacao.get(String(sourceRow[column])) || null;
            if (column === 'codsetor' && mappings.setor) return mappings.setor.get(String(sourceRow[column])) || null;
            if (column === 'codpessoa' && mappings.pessoa) return mappings.pessoa.get(String(sourceRow[column])) || null;
            return sourceRow[column];
          });
          const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
          const returning = def.pk ? ` RETURNING ${def.pk}` : '';
          const inserted = await client.query(`INSERT INTO ${table} (${def.columns.join(', ')}) VALUES (${placeholders})${returning}`, values);
          if (def.pk && inserted.rows[0]) mappings[table].set(String(sourceRow[def.pk]), inserted.rows[0][def.pk]);
          copied[table] += 1;
        }
      }
      await client.query('COMMIT');
      res.json({ status: 'ok', copied });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(err.message === 'Senha mestre inválida.' ? 401 : 400).json({ error: err.message });
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