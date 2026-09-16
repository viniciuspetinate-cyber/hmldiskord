# AIQCALL v13 — início rápido e confiável da tela SFU

## Atualização v13

Várias pessoas podem compartilhar ao mesmo tempo. Uma nova transmissão não muda
a escolha de quem já está assistindo; o espectador troca pelo nome nas abas.

O emissor agora só divulga a publicação depois que sua conexão ICE com o SFU está
pronta. O espectador só considera a assinatura concluída depois que as faixas
remotas realmente chegaram. Enquanto isso, somente o espectador que clicou recebe
um caminho P2P temporário; assim o player pode começar antes da negociação SFU e
migra para o servidor sem interromper a voz. Se a assinatura falhar, a tentativa
seguinte começa após um segundo.

Foram verificados 14 testes unitários, 12 testes do gateway e um teste real com
Edge, vídeo e áudio sintéticos passando pelo Cloudflare Realtime SFU.

Publique a pasta `public` inteira e peça que todos recarreguem a página.

## Atualização v12

Esta edição chegou a selecionar automaticamente a transmissão mais recente. Esse
comportamento foi removido na v13: cada espectador mantém a tela que escolheu.

A assinatura SFU também ganhou recuperação própria: se a conexão abrir mas a
faixa de vídeo não chegar, ela é encerrada e refeita. Falhas de assinatura são
tentadas novamente sem exigir que o espectador saia e entre na chamada.

## Atualização v11

Quem assiste pode escolher `Original` ou `Esticar` na barra da transmissão.
Original preserva a proporção e pode deixar faixas pretas. Esticar ocupa a área
inteira sem cortar as bordas do vídeo, alterando a proporção da imagem. A escolha
é local a cada navegador e ambiente, fica salva e também pode ser alterada pelo
seletor no canto superior direito em tela cheia. Na navegação anônima ela dura
somente enquanto o armazenamento daquela sessão existir.

O controle altera apenas a apresentação do vídeo recebido. Mantém o isolamento
de áudio da v10. Faixas que já façam parte da imagem capturada não são removidas.
Foram verificados 12 testes unitários e 8 cenários no Edge, incluindo mudança de
16:9 para 5:4 em vídeo sintético transmitido por WebRTC, troca de formato sem
substituir o stream, tela cheia e largura de celular.

Publique a pasta `public` inteira. Após recarregar o site, selecione `Esticar`
na barra acima da transmissão para preencher a área do player.

## Atualização v10

O site agora pede `restrictOwnAudio` quando o navegador oferece suporte, para
excluir da captura de áudio do sistema o som produzido pela própria aba da chamada.
Antes de publicar qualquer faixa de áudio de monitor/janela, confere se
`getSettings().restrictOwnAudio` é `true`. Sem confirmação, remove e encerra essa
faixa: o compartilhamento de vídeo continua, com orientação para compartilhar uma
aba com áudio. O microfone continua sendo enviado separadamente.

A opção de áudio do computador fica desabilitada quando o navegador não anuncia
esse recurso. O filtro é experimental e depende do navegador; não é um filtro
de voz aplicado ao som inteiro. Para vídeos com som, compartilhar uma aba diferente
da chamada é a opção de maior compatibilidade. A troca de fonte durante a captura
fica desabilitada: pare e compartilhe novamente para selecionar outra origem.

Publique a pasta `public` inteira no GitHub, mantendo a saída do Pages em `public`.
Depois do deploy, quem compartilha deve recarregar a página e iniciar uma nova
captura. Valide com dois participantes: a voz recebida pela chamada não deve
retornar no áudio da tela, e o som da aba de vídeo deve continuar audível.
Os testes automatizados verificam as regras de captura e descarte; não medem a
eficácia acústica do filtro experimental de cada navegador.

Atualização do projeto fornecido em `hmldiskord-main.zip`, preparada em
12/09/2026. Aplicação estática com Supabase para dados/sinalização e WebRTC
em malha para voz, com Cloudflare Realtime SFU para a tela no ambiente DEV.
Não foi publicada automaticamente.

## O que mudou

- **Voz:** RNNoise local ativo por padrão, com retorno automático ao filtro nativo; seleção de microfone,
  controle de ganho automático, medidor e calibração em três segundos de silêncio.
- **Portão de ruído:** decisões no AudioWorklet, com transição suave e pequeno
  atraso de antecipação para preservar o início da fala. Não depende do timer
  da página para abrir ou fechar em segundo plano.
- **Tela sob demanda:** entre clientes v6, áudio e vídeo da tela só são enviados
  para quem escolheu assistir. Fechar o palco interrompe esse envio e mantém a voz.
- **Cloudflare SFU no DEV:** quem compartilha envia uma cópia da tela ao servidor,
  independentemente da quantidade de espectadores. A voz continua P2P e usa o TURN
  já existente. Se o SFU não responder, a tela retorna automaticamente ao P2P.
- **Qualidade ajustável:** três perfis e redução gradual por participante quando
  as estatísticas do navegador indicam limitação persistente de CPU ou banda.
- **Menos eco:** tela inteira sem áudio do sistema por padrão. A pessoa pode
  incluí-lo com isolamento confirmado pelo navegador ou compartilhar o áudio de uma aba.
- **Conexão:** candidatos ICE entregues conforme ficam disponíveis; substituição
  de faixas de mídia e parâmetros de envio aguardam a conclusão das operações.
- **Ciclo da chamada:** cancelar a entrada libera o microfone mesmo quando a
  permissão chega depois. Sair libera a captura e o processamento local.
- **Diagnóstico:** atraso, perda de pacotes, jitter, taxa de vídeo, resolução e
  indicação de rota direta/TURN quando disponíveis. Dados exibidos localmente.
- **Chat:** mensagens salvas separadamente, evitando sobrescrita em envios
  simultâneos; novas mensagens continuam aparecendo após o limite visual de 200.
- **Manutenção:** código compartilhado pelas duas salas, validação adicional de
  dados recebidos e correção das gavetas ao mudar para o layout de celular.

## Usar os controles

Entre em uma chamada. O RNNoise começa ativo e não possui seletor na interface.
Clique em **Ajustar microfone** para abrir o painel, que permanece recolhido por
padrão. O texto abaixo do medidor indica o processamento realmente ativo. Se o
RNNoise não puder iniciar, o áudio recupera usando o filtro nativo disponível.

Clique em **Calibrar no silêncio** e não fale por três segundos. Se palavras
baixas começarem a cortar, reduza o isolamento. Zero desliga apenas o portão,
preservando o filtro selecionado. RNNoise reduz ruído, mas não garante remover
outras pessoas falando perto do microfone. Um fone evita que o som dos colegas
saia pelo alto-falante e retorne ao microfone.

| Perfil de tela | Captura pretendida | Limite de upload no SFU | Uso |
|---|---|---|---|
| Texto | até 1080p / 30 fps | 3 Mbps | Documentos e código |
| Movimento | até 720p / 30 fps | 2 Mbps | Vídeos e jogos |
| Econômico | até 540p / 15 fps | 0,9 Mbps | Conexão ou computador limitado |

São limites e preferências, não qualidade ou velocidade garantidas. O navegador
pode entregar menos, dependendo da origem e dos recursos disponíveis. A adaptação
aguarda três leituras ruins para reduzir e dez boas para recuperar, a cada
2,5 segundos enquanto o timer da página estiver ativo. Ela respeita o limite do
perfil escolhido. Estatísticas ausentes não são tratadas como falhas.

O portão executa no processamento de áudio; isso não impede que o sistema
operacional suspenda o navegador, especialmente com o celular bloqueado.

## Estrutura e publicação

`public/` é a pasta a publicar. Não há comando de build:

- `index.html`: login e escolha de ambiente já existentes.
- `sala.html` e `devsala.html`: mesma interface; namespace de dados diferente.
- `storage.js`: sessão local, relógio e acesso ao Supabase.
- `sala.js` e `sala.css`: comportamento e apresentação das salas.
- `sfu-client.js`: transporte de tela pelo Worker/SFU, carregado sem segredos.
- `audio-engine.js`, `gate-worklet.js`, `vendor/rnnoise/`: processamento local.
- `novidades.js`, `_headers`, ícone e `robots.txt`: recursos de apoio.

No projeto existente de Cloudflare Pages, mantenha saída `public`, sem build.
Publique a pasta inteira, incluindo os scripts, o WASM e as licenças. Copiar
somente os HTMLs agora deixa a sala incompleta. Use HTTPS; abrir um HTML com
`file://` não reproduz as permissões e módulos de áudio do site.

**Teste primeiro em um deployment de preview separado**, usando o ambiente DEV.
DEV separa as chaves do banco, mas compartilha o código com PROD. Atualizar os
arquivos compartilhados no endereço principal também atualiza produção.

O SFU está habilitado por `SO_DEV`: `devsala.html` usa o Worker `aiqcall-sfu` e
`sala.html` continua com o transporte atual. O navegador entrega ao Worker o token
de sessão produzido no login. `SALA_SEGREDO` e `SFU_API_TOKEN` permanecem secrets
dos Workers e nunca entram nos arquivos do site. O Worker deve permitir as salas
`devsala:voz-geral` e `devsala:voz-sala-2`.

O ZIP recebido não contém o código dos Workers de login/TURN nem migrações do
banco. Os endereços e a chave pública já usados pelo projeto foram preservados.
Não é necessário trocar o backend para experimentar estas melhorias.

## Migração do chat e retorno à versão anterior

O histórico antigo em `messages:<canal>` continua sendo lido. Novos envios ficam
em `msg:<canal>:<id>`, com o mesmo prefixo de ambiente e na mesma tabela `room_kv`.
A gravação não altera nem apaga o histórico antigo. Políticas específicas que
limitem os prefixos permitidos precisam aceitar as novas chaves `msg:` e `ice:`;
essas políticas não foram fornecidas e precisam ser verificadas no preview.

**Depois de publicar, todos devem recarregar as abas.** Clientes v5 não leem as
novas mensagens v6. A compatibilidade temporária de voz com v5 mantém o envio de
tela para clientes antigos mesmo sem a nova indicação de interesse.

Guarde a versão anterior para rollback. Voltar os arquivos restaura o código,
mas v5 não exibirá mensagens gravadas nas novas chaves; elas continuam no banco.
A conversão de histórico para rollback deve ser planejada antes de uso amplo.

O limite de 200 mensagens é apenas de leitura/exibição. Não foi implementada
exclusão automática das mensagens persistidas. Defina uma política de retenção
no servidor conforme a necessidade, preservando histórico antes de excluir.

## Custos e limites

RNNoise e o portão rodam no dispositivo. O Cloudflare Realtime SFU/TURN usa a
franquia gratuita da conta e pode cobrar excedentes conforme o plano contratado.

Supabase, Cloudflare e TURN continuam sujeitos ao plano e às cotas existentes.
Mensagens separadas aumentam o número de linhas; Trickle ICE adiciona pequenas
requisições durante a conexão. Enviar tela somente a interessados tende a reduzir
upload e tráfego de relay. Isso não garante uma conta de infraestrutura zerada.

A arquitetura continua em malha: o emissor envia uma cópia por pessoa assistindo.
Por exemplo, três espectadores no limite de 3 Mbps podem exigir aproximadamente
9 Mbps de upload de vídeo, além do áudio e da sobrecarga de rede. Grupos grandes,
Wi-Fi instável e computadores fracos ainda podem apresentar travamentos.

## Segurança ainda pendente no servidor

As validações do cliente reduzem erros e entradas malformadas, mas não substituem
a autorização no servidor. O token de login não passou a autenticar as operações
REST do Supabase nesta edição. É necessário revisar os Workers e as políticas
RLS para vincular cada acesso a uma conta e restringir leitura/escrita por sala.
Isso pode ser desenvolvido sem uma licença paga, mas esses componentes não vieram
no ZIP. Não considere esta atualização uma correção completa da autenticação.

## Testes

Com Node.js, execute `npm test`. Para integração, instale as dependências de
desenvolvimento (`npm install`), instale Chromium (`npx playwright install chromium`)
e execute `npm run test:browser`. Esses pacotes são usados só nos testes.

Opcionalmente, `AIQ_BROWSER` indica o caminho de um Chrome/Edge instalado;
`AIQ_PLAYWRIGHT` indica uma instalação existente do Playwright;
`AIQ_TEST_OUTPUT` indica onde salvar evidências.

A integração usa duas páginas em Chromium, WebRTC e AudioWorklet reais,
microfones sintéticos, vídeo de canvas e backend em memória. As requisições de
serviços externos são interceptadas; não acessa dados do site publicado.

Antes da publicação definitiva, valide com pessoas em redes diferentes: fala
baixa, teclado/ventilador, aba em segundo plano, áudio de aba, tela em movimento,
entrada/saída durante compartilhamento e uso do TURN. A qualidade percebida com
microfones reais e o comportamento de NAT/rede externa não são cobertos pelo teste
local. Safari/Firefox, captura física HDMI e suspensão do celular não foram testados.

Licenças e origens: consulte `THIRD-PARTY-NOTICES.md`.
