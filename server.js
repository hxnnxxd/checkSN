const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(cors());

app.post('/api/login', (req, res) => {
  const { senha } = req.body;
  const senhaCorreta = process.env.ADMIN_PASSWORD || 'admin123';

  if (senha && senha === senhaCorreta) {
    return res.json({ sucesso: true });
  }

  return res.status(401).json({ erro: 'Senha incorreta.' });
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'controle_estoque',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false
});

async function registrarErroBD(sn, motivo, usuario) {
  try {
    await pool.query(
      "INSERT INTO logs_erros (sn, motivo, usuario) VALUES (?, ?, ?)",
      [sn, motivo, usuario]
    );
  } catch (error) {
    console.error("❌ Falha ao salvar log de erro no banco:", error.message);
  }
}

const verificarSenhaAPI = (req, res, next) => {
  const senhaInformada = req.headers['x-admin-password'];
  const senhaCorreta = process.env.ADMIN_PASSWORD || 'admin123';

  if (senhaInformada && senhaInformada === senhaCorreta) {
    next();
  } else {
    res.status(401).json({ erro: 'Não autorizado: Senha administrativa inválida ou não fornecida.' });
  }
};

// ROTA DE VALIDAÇÃO COM RETORNO COMPLETO DO PRODUTO
app.post('/api/validar-sn', async (req, res) => {
  const { sn, usuario, produtoFixadoId } = req.body;

  if (!sn || !usuario) {
    return res.status(400).json({ erro: 'A SN e o E-mail/Usuário são obrigatórios.' });
  }

  const dadoBruto = String(sn).trim();

  try {
    if (/\s/.test(dadoBruto)) {
      await registrarErroBD(dadoBruto, "Contém espaços", usuario);
      return res.status(400).json({ erro: "Erro: O dado inserido não pode conter espaços em branco." });
    }

    if (/[a-z]/.test(dadoBruto)) {
      await registrarErroBD(dadoBruto, "Contém letras minúsculas", usuario);
      return res.status(400).json({ erro: "Erro: O dado inserido contém letras minúsculas." });
    }

    if (dadoBruto.length !== 24) {
      await registrarErroBD(dadoBruto, `Tamanho incorreto (${dadoBruto.length} chars)`, usuario);
      return res.status(400).json({ erro: "Erro: O dado inserido deve conter exatamente 24 caracteres." });
    }

    if (!dadoBruto.startsWith("00")) {
      await registrarErroBD(dadoBruto, "Não inicia com '00'", usuario);
      return res.status(400).json({ erro: "Erro: O dado inserido deve iniciar obrigatoriamente com '00'." });
    }

    const [duplicados] = await pool.query("SELECT id FROM check_sns WHERE sn = ?", [dadoBruto]);
    if (duplicados.length > 0) {
      await registrarErroBD(dadoBruto, "SN já cadastrada/duplicada", usuario);
      return res.status(400).json({ erro: `Erro: A SN '${dadoBruto}' JÁ FOI VALIDADA anteriormente!` });
    }

    const downloadIdExtraido = dadoBruto.substring(2, 7);
    const hardwareNsExtraido = dadoBruto.substring(14, 16);
    const chaveSN = downloadIdExtraido + hardwareNsExtraido;

    const [produtosEncontrados] = await pool.query(
      "SELECT * FROM produtos WHERE download_id = ? AND hardware_ns = ?",
      [downloadIdExtraido, hardwareNsExtraido]
    );

    if (produtosEncontrados.length === 0) {
      const motivo = `Chave não cadastrada (${chaveSN})`;
      await registrarErroBD(dadoBruto, motivo, usuario);
      return res.status(400).json({
        erro: `Erro: Chave '${chaveSN}' (Download ID: ${downloadIdExtraido} | HW: ${hardwareNsExtraido}) não possui cadastro!`
      });
    }

    let produtoFinal = null;

    if (produtoFixadoId) {
      produtoFinal = produtosEncontrados.find(p => p.id == produtoFixadoId);
      if (!produtoFinal) {
        await registrarErroBD(dadoBruto, "SN incompatível com o produto fixado no lote", usuario);
        return res.status(400).json({
          erro: `Erro: Esta SN pertence a outro modelo/produto e diverge do produto selecionado para este lote!`
        });
      }
    } else {
      if (produtosEncontrados.length > 1) {
        return res.json({
          requerSelecao: true,
          mensagem: "Múltiplos produtos encontrados. Selecione o produto deste lote:",
          produtos: produtosEncontrados
        });
      }
      produtoFinal = produtosEncontrados[0];
    }

    await pool.query(
      "INSERT INTO check_sns (sn, usuario) VALUES (?, ?)",
      [dadoBruto, usuario]
    );

    return res.json({
      sucesso: true,
      mensagem: `SN '${dadoBruto}' registrada com sucesso!`,
      produto: produtoFinal // Retorna TODOS os campos da tabela de produtos
    });

  } catch (error) {
    console.error("Erro no processamento da SN:", error);
    return res.status(500).json({ erro: "Erro interno no servidor." });
  }
});

// LISTAR PRODUTOS COM BUSCA E PAGINAÇÃO
app.get('/api/produtos', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search ? `%${req.query.search.trim()}%` : null;
    const offset = (page - 1) * limit;

    let query = "SELECT * FROM produtos";
    let countQuery = "SELECT COUNT(*) as total FROM produtos";
    let params = [];

    if (search) {
      const where = " WHERE produto LIKE ? OR download_id LIKE ? OR hardware_ns LIKE ? OR nome_modelo LIKE ? OR product_model LIKE ? OR product_no LIKE ?";
      query += where;
      countQuery += where;
      params = [search, search, search, search, search, search];
    }

    query += " ORDER BY id DESC LIMIT ? OFFSET ?";
    
    const [totalRows] = await pool.query(countQuery, params);
    const [rows] = await pool.query(query, [...params, limit, offset]);

    res.json({
      dados: rows,
      total: totalRows[0].total,
      pagina: page,
      totalPaginas: Math.ceil(totalRows[0].total / limit)
    });
  } catch (error) {
    console.error("Erro ao buscar produtos:", error);
    res.status(500).json({ erro: "Erro ao buscar produtos no banco." });
  }
});

// CADASTRAR PRODUTO
app.post('/api/produtos', verificarSenhaAPI, async (req, res) => {
  const {
    produto, descricao_produto, nome_modelo, descricao_modelo,
    product_model, product_no, download_id, hardware_ns
  } = req.body;

  if (!produto || !download_id || !hardware_ns) {
    return res.status(400).json({ erro: "Os campos 'PRODUTO', 'DOWNLOAD ID' e 'HARDWARE NS' são obrigatórios." });
  }

  try {
    await pool.query(
      `INSERT INTO produtos 
      (produto, descricao_produto, nome_modelo, descricao_modelo, product_model, product_no, download_id, hardware_ns) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        produto.trim(),
        descricao_produto ? descricao_produto.trim() : '',
        nome_modelo ? nome_modelo.trim() : '',
        descricao_modelo ? descricao_modelo.trim() : '',
        product_model ? product_model.trim() : '',
        product_no ? product_no.trim() : '',
        download_id.trim(),
        hardware_ns.trim()
      ]
    );

    res.json({ sucesso: true, message: "Produto cadastrado com sucesso!" });
  } catch (error) {
    console.error("Erro ao cadastrar produto:", error);
    res.status(500).json({ erro: "Erro ao salvar produto no banco de dados." });
  }
});

// EXCLUIR PRODUTO
app.delete('/api/produtos/:id', verificarSenhaAPI, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM produtos WHERE id = ?", [id]);
    res.json({ sucesso: true, mensagem: "Produto excluído com sucesso!" });
  } catch (error) {
    res.status(500).json({ erro: "Erro ao excluir produto no banco." });
  }
});

// HISTÓRICO DE SNS COM BUSCA E PAGINAÇÃO
app.get('/api/historico-sns', verificarSenhaAPI, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search ? `%${req.query.search.trim()}%` : null;
    const offset = (page - 1) * limit;

    let query = "SELECT id, sn, usuario, DATE_FORMAT(data_validacao, '%d/%m/%Y %H:%i:%s') AS data FROM check_sns";
    let countQuery = "SELECT COUNT(*) as total FROM check_sns";
    let params = [];

    if (search) {
      const where = " WHERE sn LIKE ? OR usuario LIKE ?";
      query += where;
      countQuery += where;
      params = [search, search];
    }

    query += " ORDER BY id DESC LIMIT ? OFFSET ?";

    const [totalRows] = await pool.query(countQuery, params);
    const [rows] = await pool.query(query, [...params, limit, offset]);

    res.json({
      dados: rows,
      total: totalRows[0].total,
      pagina: page,
      totalPaginas: Math.ceil(totalRows[0].total / limit)
    });
  } catch (error) {
    res.status(500).json({ erro: "Erro ao buscar histórico no banco." });
  }
});

// EXPORTAÇÃO CSV DE HISTÓRICO COMPLETO
app.get('/api/historico-sns/exportar', verificarSenhaAPI, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, sn, usuario, DATE_FORMAT(data_validacao, '%d/%m/%Y %H:%i:%s') AS data FROM check_sns ORDER BY id DESC"
    );

    let csv = "ID,SN,Usuario,Data_Validacao\n";
    rows.forEach(r => {
      csv += `"${r.id}","${r.sn}","${r.usuario}","${r.data}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="historico_sns.csv"');
    res.status(200).send('\uFEFF' + csv);
  } catch (error) {
    res.status(500).json({ erro: "Erro ao exportar relatório." });
  }
});

// LOGS DE ERRO COM BUSCA E PAGINAÇÃO
app.get('/api/logs-erros', verificarSenhaAPI, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search ? `%${req.query.search.trim()}%` : null;
    const offset = (page - 1) * limit;

    let query = "SELECT id, sn, motivo, usuario, DATE_FORMAT(data_erro, '%d/%m/%Y %H:%i:%s') AS data FROM logs_erros";
    let countQuery = "SELECT COUNT(*) as total FROM logs_erros";
    let params = [];

    if (search) {
      const where = " WHERE sn LIKE ? OR motivo LIKE ? OR usuario LIKE ?";
      query += where;
      countQuery += where;
      params = [search, search, search];
    }

    query += " ORDER BY id DESC LIMIT ? OFFSET ?";

    const [totalRows] = await pool.query(countQuery, params);
    const [rows] = await pool.query(query, [...params, limit, offset]);

    res.json({
      dados: rows,
      total: totalRows[0].total,
      pagina: page,
      totalPaginas: Math.ceil(totalRows[0].total / limit)
    });
  } catch (error) {
    res.status(500).json({ erro: "Erro ao buscar logs no banco." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));