// Lista de melhorias, compartilhada pela página inicial e pelas três salas.
//
// POR QUE UM ARQUIVO SÓ: o index e os sala/hmlsala/devsala mostram a MESMA
// lista. Com uma cópia em cada, a primeira edição já deixaria os quatro
// dizendo coisas diferentes. Editar aqui atualiza todos.
//
// Para atualizar, mexa só nisto: o primeiro grupo é o mais recente.
//
// Os textos aceitam <b> e <i>. Nada mais — o resto é escapado na exibição.
// Quem consome: htmlNovidades() nas salas, e o modal do index.html.

window.NOVIDADES_SALA = [
  { titulo: 'Novidades desta versão (v3)', itens: [
    '<b>Entrada só por conta</b> — cada pessoa tem usuário e senha próprios, nos três ambientes. A senha compartilhada da sala deixou de existir.',
    '<b>Sem conta, ninguém entra</b> — não há mais atalho embutido na página caso o serviço de login fique fora do ar.',
    '<b>Uma porta só</b> — o login agora é na página inicial e vale para os três ambientes de uma vez. Abrir uma sala direto no endereço leva de volta para lá.',
    '<b>Entrada em dois passos</b> — primeiro a conta, depois a pergunta <i>como você prefere ser chamado?</i>. Só então aparecem os ambientes.',
    '<b>Quem está onde</b> — a página inicial mostra quantas pessoas estão em cada ambiente (<i>2 Online</i>) antes de você escolher.',
    '<b>Cada ambiente tem nome e cor próprios</b> — AIQCALL PROD, HML e DEV. O nome deixou de ser editável, para ninguém confundir onde está.',
    '<b>Um segundo canal de voz</b> (Sala 2). Criar e apagar canais saiu de todos os ambientes.',
    '<b>Ícone próprio</b> na aba do navegador e na tela de entrada.',
    '<b>Volume por pessoa</b> no canal de voz — e dá para <b>parar de ouvir</b> alguém sem silenciar o resto, sem afetar o que os outros escutam.',
    '<b>Funciona no celular</b> — em tela estreita os canais e a lista de pessoas viram gavetas, e o chat ocupa a tela inteira. Vale nos três ambientes.',
    '<b>Trocar de ambiente sem sair</b> — botão no topo da barra de canais, que leva de volta à tela de escolha com a conta ainda conectada.',
    '<i>Só no Dev:</i> <b>volume do áudio da transmissão de tela</b>, separado do volume das vozes — o som de um jogo ou de um vídeo não abafa mais a conversa.',
    '<b>Apelido em qualquer ambiente</b> — a conta diz quem você é, o apelido diz como você aparece na sala. Em branco, aparece o nome da conta.',
    '<b>Trocar de nome sem sair</b> — o botão <b>Alterar Apelido</b>, na página inicial, muda como você aparece sem pedir a senha de novo.',
    '<b>Esta lista também na página inicial</b> — no canto de cima, para consultar antes de entrar em qualquer sala.',
  ]},
  { titulo: 'Versão anterior (v2)', itens: [
    '<b>A sala ficou 20× mais leve</b> — antes cada pessoa baixava o histórico do chat inteiro a cada 2,5s, mesmo sem mensagem nova.',
    '<b>Entrar na chamada ficou mais rápido</b>: a conexão não espera mais alguns segundos parada antes de começar.',
    '<b>A chamada não cai mais</b> quando o servidor engasga — quem já está conversando continua conversando.',
    '<b>Login vale 30 dias</b>, em vez de pedir senha todo dia.',
    '<b>Câmera e placa de captura</b> — dá para transmitir console ou câmera, com o áudio do próprio aparelho.',
    '<b>Bip de entrada e saída</b> nos canais de voz.',
  ]},
  { titulo: 'Compartilhamento de tela', itens: [
    '<b>Corrigido: a tela não abria</b> para quem assistia. O vídeo era destruído a cada 2,5 s pelo próprio app.',
    '<b>Tela grande</b> — ocupa a área principal, com modo teatro, tela cheia e picture-in-picture.',
    '<b>Escolha entre aba e tela inteira</b> ao compartilhar. A aba manda só o áudio dela e <b>não dá eco</b>.',
    '<b>Aviso do áudio</b> em transmissão: mostra se está indo o som da origem ou do sistema todo.',
    'Qualidade travada em 1080p — texto compartilhado continua legível.',
  ]},
  { titulo: 'Voz em grupo', itens: [
    '<b>Canais de voz</b> com lista de quem está em cada um, mudo, surdo e indicador de quem fala.',
    'Compartilhamento de tela integrado ao canal, como no Discord.',
    'Testado com <b>8 pessoas</b> na voz e <b>5 com tela</b> ao mesmo tempo.',
  ]},
  { titulo: 'Estabilidade da conexão', itens: [
    '<b>Servidor TURN</b> — as chamadas passam a funcionar em rede corporativa e no 4G.',
    '<b>Não cai mais com a aba em segundo plano</b> — o relógio saiu do navegador para um worker.',
    'Reconexão automática: quem perde conexão volta sozinho, sem sair e entrar.',
    'Corrigido: depois de algumas quedas, a pessoa ficava marcada como perdida para sempre.',
  ]},
];
