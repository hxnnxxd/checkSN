let loteAtivo = {
  email: '',
  meta: 0,
  validados: 0,
  produtoFixadoId: null,
  produtoNome: ''
};

let snPendente = '';
let acaoAposAviso = null; // Callback para quando o botão OK do modal for clicado

document.addEventListener('DOMContentLoaded', () => {
  const btnIniciarLote = document.getElementById('btnIniciarLote');
  const formSN = document.getElementById('formSN');
  const inputSN = document.getElementById('snInput');
  const btnFecharAviso = document.getElementById('btnFecharAviso');

  // Fechar Modal de Aviso
  btnFecharAviso.addEventListener('click', () => {
    document.getElementById('modalAviso').style.display = 'none';
    if (acaoAposAviso) {
      acaoAposAviso();
      acaoAposAviso = null;
    }
  });

  // Iniciar o Lote
  btnIniciarLote.addEventListener('click', () => {
    const email = document.getElementById('emailUsuario').value.trim();
    const qtd = parseInt(document.getElementById('qtdLote').value);

    if (!email || !email.includes('@')) {
      exibirAviso('Atenção', 'Por favor, informe um e-mail corporativo válido.');
      return;
    }

    if (isNaN(qtd) || qtd < 10) {
      exibirAviso('Atenção', 'A quantidade mínima permitida para validação do lote é de 10 unidades.');
      return;
    }

    // Configuração do lote ativo
    loteAtivo.email = email;
    loteAtivo.meta = qtd;
    loteAtivo.validados = 0;
    loteAtivo.produtoFixadoId = null;
    loteAtivo.produtoNome = '';

    document.getElementById('infoEmail').innerText = email;
    document.getElementById('metaLote').innerText = qtd;
    document.getElementById('contadorLote').innerText = '0';
    document.getElementById('infoProdutoFixado').innerText = 'Aguardando 1ª bipagem...';

    document.getElementById('secaoConfigLote').style.display = 'none';
    document.getElementById('secaoBipagem').style.display = 'block';
    inputSN.focus();
  });

  // Evento de Envio da SN
  formSN.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sn = inputSN.value; // Mantém caractere bruto
    if (!sn) return;

    await enviarValidacao(sn, loteAtivo.produtoFixadoId);
  });
});

async function enviarValidacao(sn, produtoId) {
  const inputSN = document.getElementById('snInput');
  const divMsg = document.getElementById('mensagem');

  snPendente = sn;

  const res = await fetch('/api/validar-sn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sn: sn,
      usuario: loteAtivo.email,
      produtoFixadoId: produtoId
    })
  });

  const data = await res.json();

  if (res.ok) {
    if (data.requerSelecao) {
      // Abre Modal de Seleção na 1ª vez
      exibirModalSelecao(data.produtos);
    } else {
      fecharModalSelecao();

      // Fixa o produto para as próximas bipagens
      if (!loteAtivo.produtoFixadoId) {
        loteAtivo.produtoFixadoId = data.produto.id;
        loteAtivo.produtoNome = `${data.produto.produto} (${data.produto.nome_modelo})`;
        document.getElementById('infoProdutoFixado').innerText = loteAtivo.produtoNome;
      }

      divMsg.className = 'mensagem sucesso';
      divMsg.innerText = `${data.mensagem} | Produto: ${data.produto.produto}`;
      inputSN.value = '';
      inputSN.focus();

      loteAtivo.validados++;
      document.getElementById('contadorLote').innerText = loteAtivo.validados;

      // Conclusão do Lote
      if (loteAtivo.validados >= loteAtivo.meta) {
        exibirAviso(
          '🎉 Lote Concluído!', 
          `O lote de ${loteAtivo.meta} unidades do produto ${loteAtivo.produtoNome} foi finalizado com SUCESSO!`,
          () => location.reload()
        );
      }
    }
  } else {
    fecharModalSelecao();
    divMsg.className = 'mensagem erro';
    divMsg.innerText = data.erro;
    inputSN.value = '';
    inputSN.focus();
  }
}

// Funções dos Modais
function exibirModalSelecao(produtos) {
  const modal = document.getElementById('modalSelecao');
  const lista = document.getElementById('listaProdutos');
  lista.innerHTML = '';

  produtos.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'btn-opcao';
    btn.innerHTML = `<strong>${p.produto}</strong> - ${p.descricao_produto}<br><small>Modelo: ${p.nome_modelo}</small>`;
    btn.onclick = () => enviarValidacao(snPendente, p.id);
    lista.appendChild(btn);
  });

  modal.style.display = 'flex';
}

function fecharModalSelecao() {
  document.getElementById('modalSelecao').style.display = 'none';
}

function exibirAviso(titulo, texto, callback = null) {
  document.getElementById('tituloAviso').innerText = titulo;
  document.getElementById('textoAviso').innerText = texto;
  document.getElementById('modalAviso').style.display = 'flex';
  acaoAposAviso = callback;
}

function acessarAdmin() {
  // Abre uma caixinha no navegador pedindo a senha
  const senha = prompt("Digite a senha de administrador:");
  
  if (senha) {
    // Redireciona para o admin passando a senha na URL de forma segura
    window.location.href = `/admin.html?senha=${encodeURIComponent(senha)}`;
  }
}