(function(){
  const SB_URL = "https://rwkuklrvppzhyzrtiloe.supabase.co";
  const SB_KEY = "sb_publishable_bUBRlX_BgoM0ACqWyz4WDw_vC4F_OL2";
  const H = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };
  const REST = SB_URL + "/rest/v1/room_kv";

  // ---------- ESPAÇO DE DADOS POR ARQUIVO ----------
  // Todos os arquivos falam com a mesma tabela room_kv. Sem separar, uma cópia
  // de teste (devsala.html) escreve nas MESMAS chaves da sala de produção e as
  // mensagens aparecem lá. Aqui cada nome de arquivo ganha seu próprio espaço:
  //
  //   sala.html      -> sem prefixo (a sala de produção, dados atuais preservados)
  //   devsala.html   -> prefixo "devsala:"  (isolado)
  //   qualquercoisa.html -> prefixo "qualquercoisa:"
  //
  // Ou seja: basta copiar o arquivo com outro nome e ele já nasce isolado.
  // O espaço de dados é DECLARADO, não deduzido. Deduzir pelo nome do arquivo
  // quebra em hospedagens que mexem no endereço — o Cloudflare Pages, por
  // exemplo, serve /sala.html como /sala, e aí o nome some. Com o valor
  // escrito aqui, o arquivo vai para o lugar certo esteja onde estiver.
  //
  //   "producao"  -> a sala de verdade, sem prefixo
  //   (homologação foi removida; ver README)
  //   "devsala"   -> desenvolvimento
  //   ""          -> (não recomendado) deduz pelo nome do arquivo
  const ESPACO_FORCADO = document.documentElement.dataset.ambiente || "producao";

  const ARQUIVO = (location.pathname.split("/").pop() || "sala.html").toLowerCase();
  const NS = ESPACO_FORCADO === "producao" ? ""
    : ESPACO_FORCADO ? ESPACO_FORCADO + ":"
    : ((ARQUIVO === "sala.html" || ARQUIVO === "") ? "" : ARQUIVO.replace(/\.html?$/, "") + ":");
  window.__SALA_ARQUIVO = ESPACO_FORCADO || ARQUIVO;
  window.__SALA_NS = NS;                                    // "" quando é produção
  window.__SALA_ESPACO = NS ? NS.slice(0, -1) : "producao"; // nome legível do espaço

  // ---------- PORTA ÚNICA ----------
  // O login mora no index.html, que confere a conta no Worker e grava a sessão
  // para os três ambientes de uma vez. Este arquivo não tem mais tela de
  // entrada própria: sem sessão válida, volta para a porta.
  //
  // A conferência é aqui, antes de montar qualquer coisa, por dois motivos: a
  // sessão está no localStorage e é leitura instantânea, e adiar faria o
  // formulário antigo piscar na tela antes do redirecionamento.
  //
  // O QUE ISTO É: uma tranca de conveniência, que impede entrar na sala sem
  // passar pelo login. O QUE NÃO É: proteção dos dados. O arquivo é estático e
  // carrega a chave publicável do Supabase, então quem lê o código-fonte
  // alcança a tabela sem abrir esta página. Fechar isso de verdade exige
  // revogar o acesso anônimo no Supabase e rotear o banco por um servidor.
  // "./" e não "index.html": o Pages serve as salas em /sala e /devsala, sem
  // extensão, e "index.html" viraria /index.html — um endereço
  // que depende do Pages redirecionar para "/". Com "./" a navegação vai direto
  // para a raiz, que é onde o index é servido, seja o endereço /devsala ou
  // /devsala.html.
  const PORTA = './';
  const ESPACOS_SESSAO = ['', 'devsala:'];
  // Homologação foi removida. O prefixo continua na limpeza para que a chave de
  // sessão de quem usou o hmlsala saia do navegador em vez de ficar lá para
  // sempre. Nunca é LIDO — só apagado.
  const ESPACOS_APOSENTADOS = ['hmlsala:'];

  function apagarSessaoDeTodos(){
    // Sair de um ambiente sai de todos: a sessão é uma só, gravada nos três.
    // Limpar só o daqui deixaria o index achando que ainda há login válido.
    for (const p of ESPACOS_SESSAO.concat(ESPACOS_APOSENTADOS)){
      try{ localStorage.removeItem('local:' + p + 'sessao'); }catch(e){}
      try{ localStorage.removeItem('local:' + p + 'nickname'); }catch(e){}
    }
  }

  function sessaoDoEspaco(){
    try{
      const raw = localStorage.getItem('local:' + NS + 'sessao');
      if (!raw) return null;
      const s = JSON.parse(raw);
      return (s && s.usuario && s.exp && s.exp > Math.floor(Date.now()/1000)) ? s : null;
    }catch(e){ return null; }
  }

  // Uma função só para a volta à porta, usada aqui e no botão de sair. O
  // redirecionamento pode falhar (navegação bloqueada, arquivo aberto direto
  // do disco), e nesse caso o que fecha a tranca é o `return` de quem chama:
  // sem sessão o app não é montado, aconteça o que acontecer com a navegação.
  function voltarParaPorta(){
    apagarSessaoDeTodos();

    // Cada tentativa só acontece se a anterior falhou de verdade (lançou).
    // Um reload agendado "por garantia" seria pior que o problema: navegação
    // lenta ainda em andamento seria cancelada por ele, e a pessoa voltaria
    // para a sala que estava tentando deixar.
    try{ location.replace(PORTA); return; }
    catch(e){ console.warn('[sala] replace para a porta falhou', e); }

    try{ location.href = PORTA; return; }
    catch(e){ console.warn('[sala] href para a porta falhou', e); }

    // Nenhuma das duas pegou. Recarregar basta: a sessão já foi apagada acima,
    // então o guard no topo deste arquivo barra o app. Pior caso, a pessoa fica
    // numa tela que não é a sala, em vez de continuar dentro dela.
    try{ location.reload(); }catch(e){}
  }

  // Este arquivo tem DOIS blocos <script>, e cada um é um escopo próprio: o
  // que é `function` aqui NÃO se vê no bloco de baixo, onde vive o resto do
  // app. Foi exatamente esse o bug do botão "sair" — ele chamava
  // apagarSessaoDeTodos() e voltarParaPorta() de lá, e recebia
  // "is not defined", sem sair. Publicar em window é o mesmo caminho que este
  // bloco já usa para `storage` e `agoraServidor`.
  window.__SALA_PORTA = {
    endereco: PORTA,
    apagarSessao: apagarSessaoDeTodos,
    sessao: sessaoDoEspaco,
    voltar: voltarParaPorta,
  };

  if (!sessaoDoEspaco()){
    // O `return` abaixo encerra ESTE bloco <script>, e só ele. O bloco de
    // baixo — o app inteiro — é independente e roda de qualquer forma, então a
    // barreira precisa ser anunciada para ele também. Sem isto, a sala montava
    // a interface completa por trás do redirecionamento; só não conseguia
    // falar com o banco, porque `window.storage` é definido mais abaixo aqui.
    window.__SALA_BARRADO = true;
    voltarParaPorta();
    return;
  }

  // O prefixo entra na ida e sai na volta, então quem chama continua vendo as
  // chaves como sempre — importante porque a sinalização faz split(":") nelas.
  // ---------- RELÓGIO DO SERVIDOR ----------
  // Todo horário que é COMPARADO ENTRE PESSOAS tem que vir de um relógio só.
  // Se cada navegador usar o próprio, quem estiver com a hora errada apaga
  // coisa dos outros e some da lista sem motivo. Toda resposta HTTP traz o
  // cabeçalho Date, então dá para medir o desvio sem pedir nada a mais.
  let desvioRelogio = 0;   // servidor menos cliente, em ms
  function anotarRelogio(r){
    try{
      const d = r.headers.get("Date");
      if (!d) return;
      const t = Date.parse(d);
      if (t) desvioRelogio = t - Date.now();
    }catch(e){}
  }
  window.agoraServidor = () => Date.now() + desvioRelogio;
  window.__anotarRelogio = anotarRelogio;   // para o resto do app também aproveitar
  window.__SALA_DESVIO_RELOGIO = () => Math.round(desvioRelogio / 1000);

  const comNS = (k) => NS + k;
  const semNS = (k) => (NS && k.startsWith(NS) ? k.slice(NS.length) : k);

  async function fetchDB(url, options={}){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),10000);
    try{return await fetch(url,{...options,signal:controller.signal});}
    finally{clearTimeout(timer);}
  }
  window.storage = {
    async messageHead(channel){
      const prefix = comNS('msg:' + channel + ':');
      const r = await fetchDB(REST + '?select=key&key=like.' + encodeURIComponent(prefix + '*') + '&order=updated_at.desc,key.desc&limit=1', {
        headers:{ ...H, Prefer:'count=exact' }
      });
      anotarRelogio(r);
      if (!r.ok) throw new Error('messageHead failed ' + r.status);
      const rows = await r.json();
      const count = r.headers.get('Content-Range')?.split('/')[1];
      return {revision:count && count !== '*' ? count + ':' + (rows[0]?.key || '') : null};
    },
    async recentMessages(channel){
      const prefix = comNS('msg:' + channel + ':');
      const r = await fetchDB(REST + '?select=key,value&key=like.' + encodeURIComponent(prefix + '*') + '&order=updated_at.desc,key.desc&limit=200', {headers:H});
      anotarRelogio(r);
      if (!r.ok) throw new Error('recentMessages failed ' + r.status);
      return r.json();
    },

    async get(key, shared){
      if (!shared){
        const v = localStorage.getItem("local:" + NS + key);
        return v === null ? null : { value: v };
      }
      const r = await fetchDB(REST + "?select=value&key=eq." + encodeURIComponent(comNS(key)), { headers: H });
      anotarRelogio(r);
      if (!r.ok) throw new Error("get failed " + r.status);
      const rows = await r.json();
      return rows.length ? { value: rows[0].value } : null;
    },
    async set(key, value, shared){
      if (!shared){ localStorage.setItem("local:" + NS + key, String(value)); return true; }
      const r = await fetchDB(REST + "?on_conflict=key", {
        method: "POST",
        headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: comNS(key), value: String(value), updated_at: new Date(window.agoraServidor()).toISOString() })
      });
      anotarRelogio(r);
      if (!r.ok) throw new Error("set failed " + r.status);
      return true;
    },
    async delete(key, shared){
      if (!shared){ localStorage.removeItem("local:" + NS + key); return true; }
      const r = await fetchDB(REST + "?key=eq." + encodeURIComponent(comNS(key)), {
        method: "DELETE", headers: { ...H, Prefer: "return=minimal" }
      });
      anotarRelogio(r);
      if (!r.ok) throw new Error("delete failed " + r.status);
      return true;
    },
    // Busca várias chaves numa requisição só, e devolve APENAS as que mudaram
    // desde o carimbo informado. Em regime normal ninguém falou nada e a
    // resposta vem vazia — antes baixávamos o histórico inteiro do chat a cada
    // ciclo, por pessoa. O carimbo vem do próprio banco, então relógio
    // desregulado no cliente não atrapalha.
    async getChanged(keys, desde){
      const lista = keys.map(k => '"' + encodeURIComponent(comNS(k)) + '"').join(",");
      let url = REST + "?select=key,value,updated_at&key=in.(" + lista + ")";
      if (desde) url += "&updated_at=gt." + encodeURIComponent(desde);
      const r = await fetchDB(url, { headers: H });
      anotarRelogio(r);
      if (!r.ok) throw new Error("getChanged failed " + r.status);
      let carimbo = desde || null;
      const valores = {};
      for (const row of await r.json()){
        valores[semNS(row.key)] = row.value;
        if (!carimbo || row.updated_at > carimbo) carimbo = row.updated_at;
      }
      return { valores, carimbo };
    },
    // Busca várias chaves numa requisição só. O laço principal pedia 4 coisas
    // em série; a ~0,5s cada, o ciclo levava o próprio intervalo inteiro para
    // terminar e vivia atrasado.
    async getMany(keys){
      const lista = keys.map(k => '"' + encodeURIComponent(comNS(k)) + '"').join(",");
      const r = await fetchDB(REST + "?select=key,value&key=in.(" + lista + ")", { headers: H });
      anotarRelogio(r);
      if (!r.ok) throw new Error("getMany failed " + r.status);
      const mapa = {};
      for (const row of await r.json()) mapa[semNS(row.key)] = row.value;
      return mapa;
    },
    // Lê todas as linhas cuja chave começa com `prefix`. É o que permite fazer
    // presença e sinalização sem read-modify-write concorrente numa única chave.
    async list(prefix){
      const r = await fetchDB(REST + "?select=key,value&key=like." + encodeURIComponent(comNS(prefix) + "*"), { headers: H });
      anotarRelogio(r);
      if (!r.ok) throw new Error("list failed " + r.status);
      const rows = await r.json();
      // Devolve sem o prefixo: a sinalização faz split(":") nessas chaves e
      // contaria os pedaços errado se o namespace viesse junto.
      return rows.map(row => ({ key: semNS(row.key), value: row.value }));
    },
    // Apaga por prefixo o que estiver parado há mais de `ms`. Serve para a
    // sinalização abandonada por quem fecha a aba de repente — o beforeunload
    // não consegue garantir a limpeza das chaves que a pessoa escreveu para os
    // outros, e elas iam acumulando na tabela.
    async deleteOlderThan(prefix, ms){
      const limite = new Date(window.agoraServidor() - ms).toISOString();
      const r = await fetchDB(REST + "?key=like." + encodeURIComponent(comNS(prefix) + "*") +
        "&updated_at=lt." + encodeURIComponent(limite), {
        method: "DELETE", headers: { ...H, Prefer: "return=minimal" }
      });
      anotarRelogio(r);
      if (!r.ok) throw new Error("deleteOlderThan failed " + r.status);
      return true;
    },
    async deletePrefix(prefix, keepalive){
      const r = await fetchDB(REST + "?key=like." + encodeURIComponent(comNS(prefix) + "*"), {
        method: "DELETE", headers: { ...H, Prefer: "return=minimal" }, keepalive: !!keepalive
      });
      anotarRelogio(r);
      if (!r.ok) throw new Error("deletePrefix failed " + r.status);
      return true;
    }
  };
})();
