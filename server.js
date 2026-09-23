const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middlewares
app.use(express.json());
app.use(cors());

// =======================================================
// ROTA PROTEGIDA PARA ACESSAR O ADMIN.HTML
// =======================================================
app.get('/admin.html', (req, res) => {
  const senhaInformada = req.query.senha;
  const senhaCorreta = process.env.ADMIN_PASSWORD || ''; // 'admin123' é o padrão local caso não configure na Render

  if (senhaInformada === senhaCorreta) {
    // Se a senha estiver correta via query string, entrega o arquivo HTML
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    // Caso contrário, bloqueia o acesso
    res.status(403).send('<h1 style="color:red; text-align:center; margin-top:50px;">❌ Acesso Negado: Senha incorreta ou não fornecida.</h1>');
  }
});

// Servir arquivos estáticos da pasta public (O Express pula o admin.html por causa da rota acima)
app.use(express.static(path.join(__dirname, 'public')));

// Configuração do Pool de Conexões do MySQL (Adaptado para Local e Nuvem)
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

// Testar a conexão ao iniciar o servidor
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Conexão com o banco MySQL estabelecida com sucesso!');
    connection.release();
  } catch (error) {
    console.error('❌ Erro ao conectar ao banco MySQL:', error.message);
  }
})();

// Função auxiliar para registrar logs de erro
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

// MIDDLEWARE: Proteção para as APIs de gravação/exclusão do Admin
const verificarSenhaAPI = (req, res, next) => {
  const senhaInformada = req.headers['x-admin-password'];
  const senhaCorreta = process.env.ADMIN_PASSWORD || 'admin123';

  if (senhaInformada === senhaCorreta) {
    next(); // Senha confere, avança para a rota desejada
  } else {
    res.status(401).json({ erro: 'Não autorizado: Senha administrativa inválida.' });
  }
};

// =======================================================
// ROTA DE VALIDAÇÃO COM SUPORTE A MÚLTIPLOS PRODUTOS E LOTE
// =======================================================
app.post('/api/validar-sn', async (req, res) => {
  const { sn, usuario, produtoFixadoId } = req.body;

  if (!sn || !usuario) {
    return res.status(400).json({ erro: 'A SN e o E-mail/Usuário são obrigatórios.' });
  }

  const dadoBruto = String(sn);

  try {
    // 1. Verificação de Espaços
    if (/\s/.test(dadoBruto) || dadoBruto.includes(' ')) {
      await registrarErroBD(dadoBruto, "Contém espaços", usuario);
      return res.status(400).json({ erro: "Erro: O dado inserido não pode conter espaços em branco." });
    }

    // 2. Trava de Letras Minúsculas
    if (/[a-z]/.test(dadoBruto)) {
      await registrarErroBD(dadoBruto, "Contém letras minúsculas", usuario);
      return res.status(400).json({ erro: "Erro: O dado inserido contém letras minúsculas." });
    }

    // 3. Tamanho exato de 24 caracteres
    if (dadoBruto.length !== 24) {
      await registrarErroBD(dadoBruto, `Tamanho incorreto (${dadoBruto.length} chars)`, usuario);
      return res.status(400).json({ erro: "Erro: O dado inserido deve conter exatamente 24 caracteres." });
    }

    // 4. Prefixo '00'
    if (!dadoBruto.startsWith("00")) {
      await registrarErroBD(dadoBruto, "Não inicia com '00'", usuario);
      return res.status(400).json({ erro: "Erro: O dado inserido deve iniciar obrigatoriamente com '00'." });
    }

    // 5. Checagem de Duplicidade Global (SN já validada)
    const [duplicados] = await pool.query("SELECT id FROM check_sns WHERE sn = ?", [dadoBruto]);
    if (duplicados.length > 0) {
      await registrarErroBD(dadoBruto, "SN já cadastrada/duplicada", usuario);
      return res.status(400).json({ erro: `Erro: A SN '${dadoBruto}' JÁ FOI VALIDADA anteriormente!` });
    }

    // 6. Extração da Chave (Download ID e Hardware NS)
    const downloadIdExtraido = dadoBruto.substring(2, 7);
    const hardwareNsExtraido = dadoBruto.substring(14, 16);
    const chaveSN = downloadIdExtraido + hardwareNsExtraido;

    // Busca produtos compatíveis com a chave no banco
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

    // SE O LOTE JÁ TEM UM PRODUTO FIXADO:
    if (produtoFixadoId) {
      produtoFinal = produtosEncontrados.find(p => p.id == produtoFixadoId);
      
      if (!produtoFinal) {
        await registrarErroBD(dadoBruto, "SN incompatível com o produto fixado no lote", usuario);
        return res.status(400).json({
          erro: `Erro: Esta SN pertênce a outro modelo/produto e diverge do produto selecionado para este lote!`
        });
      }
    } 
    // SE O LOTE AINDA NÃO TEM PRODUTO FIXADO:
    else {
      if (produtosEncontrados.length > 1) {
        return res.json({
          requerSelecao: true,
          mensagem: "Múltiplos produtos encontrados. Selecione o produto deste lote:",
          produtos: produtosEncontrados
        });
      }
      
      produtoFinal = produtosEncontrados[0];
    }

    // 7. Salva a SN validada
    await pool.query(
      "INSERT INTO check_sns (sn, usuario) VALUES (?, ?)",
      [dadoBruto, usuario]
    );

    return res.json({
      sucesso: true,
      mensagem: `SN '${dadoBruto}' registrada com sucesso!`,
      produto: produtoFinal
    });

  } catch (error) {
    console.error("Erro no processamento da SN:", error);
    return res.status(500).json({ erro: "Erro interno no servidor." });
  }
});

// =======================================================
// ROTAS DE GESTÃO DE PRODUTOS / DADOS MESTRES
// =======================================================

// 1. Listar todos os produtos (Livre para carregar na listagem)
app.get('/api/produtos', async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM produtos ORDER BY id DESC");
    res.json(rows);
  } catch (error) {
    console.error("Erro ao buscar produtos:", error);
    res.status(500).json({ erro: "Erro ao buscar produtos no banco." });
  }
});

// 2. Cadastrar produto (Protegido por senha)
app.post('/api/produtos', verificarSenhaAPI, async (req, res) => {
  const {
    produto,
    descricao_produto,
    nome_modelo,
    descricao_modelo,
    product_model,
    product_no,
    download_id,
    hardware_ns
  } = req.body;

  if (!produto || !download_id || !hardware_ns) {
    return res.status(400).json({ 
      erro: "Os campos 'PRODUTO', 'DOWNLOAD ID' e 'HARDWARE NS' são obrigatórios." 
    });
  }

  const prodLimpo = produto.trim();
  const dlIdLimpo = download_id.trim();
  const hwNsLimpo = hardware_ns.trim();

  try {
    const [existentes] = await pool.query(
      "SELECT id FROM produtos WHERE produto = ?",
      [prodLimpo]
    );

    if (existentes.length > 0) {
      return res.status(400).json({
        erro: `Erro: O código de produto '${prodLimpo}' já está cadastrado no sistema!`
      });
    }

    await pool.query(
      `INSERT INTO produtos 
      (produto, descricao_produto, nome_modelo, descricao_modelo, product_model, product_no, download_id, hardware_ns) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        prodLimpo,
        descricao_produto ? descricao_produto.trim() : '',
        nome_modelo ? nome_modelo.trim() : '',
        descricao_modelo ? descricao_modelo.trim() : '',
        product_model ? product_model.trim() : '',
        product_no ? product_no.trim() : '',
        dlIdLimpo,
        hwNsLimpo
      ]
    );

    res.json({ sucesso: true, message: "Produto cadastrado com sucesso!" });

  } catch (error) {
    console.error("Erro ao cadastrar produto:", error);

    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ 
        erro: `Erro: O produto '${prodLimpo}' já existe no banco de dados.` 
      });
    }

    res.status(500).json({ erro: "Erro ao salvar produto no banco de dados." });
  }
});

// 3. Excluir produto (Protegido por senha)
app.delete('/api/produtos/:id', verificarSenhaAPI, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM produtos WHERE id = ?", [id]);
    res.json({ sucesso: true, mensagem: "Produto excluído com sucesso!" });
  } catch (error) {
    console.error("Erro ao excluir produto:", error);
    res.status(500).json({ erro: "Erro ao excluir produto no banco." });
  }
});

// Inicialização estável da porta do servidor para a Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
