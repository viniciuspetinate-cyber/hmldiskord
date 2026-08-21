# Sala

Chat com voz em grupo e compartilhamento de tela, num único arquivo HTML por
ambiente. Não tem build: os arquivos em `public/` são servidos como estão.

## A porta é o index

`public/index.html` é a única tela de login. Ele confere a conta no Worker
`sala-auth`, grava a sessão para os três ambientes de uma vez e só então mostra
a lista, com um contador de quantas pessoas estão em cada um. Tem saudação
("Olá, Fulano") e botão de sair, que apaga a sessão dos três.

Abrir `/sala`, `/hmlsala` ou `/devsala` direto no endereço, sem sessão válida,
devolve a pessoa para o index. A conferência acontece antes de montar a tela,
então o formulário antigo não pisca — e se o redirecionamento falhar por
qualquer motivo, o app simplesmente não carrega. Falha fechando, não abrindo.

**O que isto protege e o que não protege.** Protege o acesso: ninguém entra na
sala sem passar pelo login. NÃO protege os dados: os arquivos são estáticos e
carregam a chave publicável do Supabase, cujas políticas liberam leitura e
escrita para qualquer um. Quem lê o código-fonte alcança a tabela sem abrir
página nenhuma. Fechar isso exige revogar o acesso anônimo no Supabase e rotear
o banco por um servidor.

## Ambientes

| Arquivo | Espaço de dados | Entrada |
|---|---|---|
| `public/index.html` | — | login em dois passos: conta, depois o nome de exibição |
| `public/sala.html` | produção | sessão do index |
| `public/hmlsala.html` | `hmlsala` | sessão do index |
| `public/devsala.html` | `devsala` | sessão do index |

Os três compartilham a mesma tabela no Supabase, separados por prefixo de
chave. Homologação e desenvolvimento mostram um selo vermelho e `[DEV]` na aba,
para ninguém confundir com a sala real.

O apelido é digitado no index e vale em todos os ambientes: a conta diz quem a
pessoa é, o apelido diz como ela aparece. Em branco, aparece o nome da conta. O
vínculo apelido/conta fica na sessão, então quem administra as contas continua
sabendo quem é quem.

Dois efeitos colaterais de deixar o apelido livre, que valem saber: a presença
é gravada na chave `mb:<apelido>`, então trocar de apelido faz a pessoa
aparecer como alguém novo na lista, e dois apelidos iguais colidem na mesma
chave. O ajuste de volume por pessoa também é guardado pelo nome exibido.

O espaço de dados de cada arquivo está fixo dentro dele (`ESPACO_FORCADO`), então
renomear o arquivo não mistura os dados.

## Publicar na Cloudflare Pages

Workers & Pages → Create → Pages → Connect to Git → escolha este repositório.

    Framework preset ......... None
    Build command ............ (deixe vazio)
    Build output directory ... public
    Root directory ........... (deixe vazio)

A cada push na branch principal, o site é republicado sozinho.

### Domínio próprio (importante)

Redes corporativas costumam bloquear `*.pages.dev` por categoria. Se o time não
conseguir abrir o endereço `.pages.dev`, aponte um subdomínio de vocês em
Custom domains — o bloqueio é pelo nome, não pelo servidor.

## Serviços externos

| Worker | Para quê | Variáveis |
|---|---|---|
| `sala-auth` | valida a entrada | `SALA_USUARIOS`, `SALA_SEGREDO` |
| `sala-turn-api` | credenciais TURN das chamadas | `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` |

O código dos dois está em `cloudflare/`, como cópia versionada do que está
publicado. Eles não sobem daqui: são colados no editor do Worker.

## O que tem em `public/`

| Arquivo | Para quê |
|---|---|
| `index.html` | login e escolha do ambiente — a porta |
| `sala.html`, `hmlsala.html`, `devsala.html` | as salas; idênticos exceto `ESPACO_FORCADO` |
| `novidades.js` | lista de melhorias, compartilhada pelos quatro |
| `_headers` | manda o navegador conferir se há versão nova a cada carregamento |
| `icone.png`, `icone-144.png`, `favicon.ico` | o ícone |

Os três HTMLs de sala precisam continuar iguais fora da linha do
`ESPACO_FORCADO`. Para conferir depois de mexer:

```bash
L=$(grep -n 'ESPACO_FORCADO = ' public/sala.html | cut -d: -f1); diff <(sed "${L}d" public/sala.html) <(sed "${L}d" public/hmlsala.html)
```

Não existe mais senha compartilhada de sala. A entrada é sempre por conta
individual cadastrada em `SALA_USUARIOS`, e se o Worker estiver fora do ar a
sala NÃO deixa ninguém entrar — não há atalho embutido no HTML. A variável
`SALA_SENHA` deixou de ser lida: apague-a no painel do Worker.

## DOIS blocos `<script>` — leia antes de mexer

Cada arquivo de sala tem **dois** blocos `<script>`, e cada um é um IIFE, ou
seja, **um escopo próprio**:

| Bloco | O que tem |
|---|---|
| 1º | espaço de dados (`NS`), relógio do servidor, guard da porta única, `window.storage` |
| 2º | o app inteiro: login, canais, chat, voz, palco, celular |

Uma `function` ou `const` declarada no primeiro **não existe** no segundo. Isso
já custou um bug: o botão "sair" chamava `apagarSessaoDeTodos()` e
`voltarParaPorta()`, ambas do primeiro bloco, e recebia `is not defined` — sem
sair e sem nada visível na tela, porque o erro morria dentro do handler.

A travessia é por `window`, que é o caminho que o primeiro bloco já usava para
`storage` e `agoraServidor`:

```js
window.__SALA_PORTA = { endereco, apagarSessao, sessao, voltar };   // 1º bloco
const PONTE_PORTA = window.__SALA_PORTA || {};                      // 2º bloco
```

O segundo bloco tem plano B para as duas funções, escrito para não depender de
nada do primeiro — se a ponte faltar, sair continua funcionando.

**O `return` do guard também só vale para o primeiro bloco.** O segundo roda de
qualquer forma. Por isso o guard marca `window.__SALA_BARRADO = true` antes de
sair, e o segundo bloco confere isso na primeira linha. Sem essa marca a sala
montava a interface completa — barra lateral, listeners, laço de polling —
atrás de um redirecionamento em andamento.

## Celular

O `index.html` é responsivo sempre. Abaixo de 520px o cartão de ambiente passa
a duas linhas — identidade em cima, contador e etiqueta embaixo — porque numa
linha só a descrição era espremida em três linhas estreitas. Abaixo de 360px a
legenda de cores do pé sai.

Nas salas o layout de celular vale nos **três** ambientes (`MOBILE_OK = true`).
Ele liga a classe `mobile-ok` no `<body>`, e todo o CSS de celular está preso a
ela — para desligar, ponha `false`.

O problema que isso resolve: em 375px a régua de 64px mais os canais de 200px
deixavam **111px** para o chat.

**O corte é 600px**, não mais. Em 800px — um notebook pequeno — os três painéis
ainda cabem com folga, e tablet em retrato (768px) também; colapsar ali só
atrapalharia. Quem ganha gaveta é celular de verdade. Se mudar esse número no
CSS, mude `ESTREITO()` junto: os dois têm que concordar.

Abaixo de 600px:

- A régua sai; o ícone do ambiente reaparece no topo da gaveta.
- Os canais viram gaveta pela esquerda, no botão ☰ do cabeçalho.
- Os membros viram gaveta pela direita, no botão `N online` que já existia.
- Abrir uma fecha a outra, e escolher um canal fecha a gaveta — sem isso a
  pessoa toca no canal e continua olhando a lista.
- Tocar no fundo escuro ou apertar Esc fecha.
- O botão de compartilhar fica só com o ícone, e o de novidades sai (a lista
  está na página inicial).
- O palco ocupa no máximo 46vh, para sobrar conversa embaixo.
- Campos de texto em 16px, que é o tamanho abaixo do qual o Safari dá zoom
  automático ao focar.

## Trocar de ambiente sem sair

Um botão `⇄ Trocar de ambiente` no topo da barra de canais, logo abaixo do nome
do ambiente. Ele **volta para a tela de escolha** — não pula direto para outro
ambiente — porque de lá dá para ver quantas pessoas estão em cada um antes de
decidir.

A diferença inteira entre ele e o "sair" é uma linha: este **não apaga a
sessão**. Por isso ele não usa `voltarParaPorta()`, que apaga a sessão dos três
espaços antes de navegar. O index, encontrando a sessão válida, mostra direto a
lista de ambientes — sem login e sem a pergunta do apelido.

Isso funciona porque o index grava a sessão para os **três** espaços de uma vez,
no login. A conta já está reconhecida do outro lado antes de a pessoa chegar
lá.

Um detalhe de CSS que vale saber: o `#menu-btn` precisa de
`#chat-header #menu-btn` para esconder no desktop. Com `#menu-btn` sozinho ele
perde para `#chat-header .head-btn{display:flex}`, que tem especificidade
maior — e o ☰ aparecia em produção.

## Lista de melhorias

`public/novidades.js` guarda a lista, e é o **único** lugar para editá-la. O
index e as três salas carregam esse arquivo e mostram o mesmo texto — com uma
cópia dentro de cada HTML, a primeira edição já deixaria os quatro dizendo
coisas diferentes.

```js
window.NOVIDADES_SALA = [
  { titulo: 'Novidades desta versão (v3)', itens: [ ... ] },
  ...
];
```

O primeiro grupo é o mais recente. Os itens aceitam `<b>` e `<i>`; o título do
grupo é escapado.

Onde aparece:

- **Nas salas**, no botão `✨ Novidades` do cabeçalho do chat — só o ícone no
  celular, para não roubar o espaço do nome do canal.
- **No index**, no botão `✨ Novidades` do canto superior direito.

**Em nenhum dos dois ela abre sozinha.** Nas salas abria quando a versão mudava
desde a última visita; deixou de abrir. Uma janela na frente de quem só queria
conversar custa mais atenção do que a novidade vale, e quem quer ler sabe onde
está o botão. Fecha no ✕, no Esc ou clicando fora.

Duas consequências disso, já tratadas no código: a chave `novidades-vistas`
não serve mais e é apagada no boot, e o painel que a lista montava aberto ao
lado da tela de entrada ficou desligado (`MOSTRAR_NOVIDADES_NA_ENTRADA`) — essa
tela não aparece mais desde a porta única.

Se `novidades.js` não carregar, a lista fica vazia e o botão não aparece, nos
quatro arquivos. Falha escondendo, não quebrando.

Isto significa que os HTMLs das salas **não são mais autossuficientes**: copiar
só o `sala.html` para outro lugar funciona, mas sem a lista de novidades.

## Contador de pessoas no index

O index conta as chaves `mb:<apelido>` da tabela, que cada sala reescreve a
cada ciclo, e considera só as carimbadas nos últimos 30 segundos. A sala usa 8
segundos para o próprio indicador; aqui a janela é maior de propósito, porque a
leitura é esporádica e uma aba em segundo plano atrasa o carimbo — com 8s
apareceria gente saindo e voltando da lista sem ter saído da sala.

Uma requisição só cobre os três ambientes, e o horário de referência vem do
cabeçalho `Date` da resposta: relógio errado na máquina de quem olha mostraria
a sala vazia ou cheia sem motivo.

Chaves antigas ficam na tabela quando a última pessoa de um ambiente sai sem a
limpeza rodar. Elas não atrapalham o contador (a janela de 30s as descarta),
mas explicam por que a tabela tem mais `mb:` do que gente.

## Conferir o que está no ar

Na tela de entrada aparece a versão. No console do navegador:

    __SALA_VERSAO           versão do arquivo carregado
    __SALA_ESPACO           espaço de dados em uso
    __SALA_TURN             se as credenciais de retransmissão chegaram
    __SALA_DESVIO_RELOGIO() erro do relógio da máquina, em segundos
    __SALA_SO_RELAY = true  antes de entrar, força a chamada pelo TURN
