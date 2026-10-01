/**
 * Feed IA — app logic
 * Fluxo: briefing (nicho, tema, nº de posts, pilares, objetivo, tom, cores)
 *        → LLM (OpenRouter, JSON estruturado: pilares + posts por tile + harmonia)
 *        → RENDER do mosaico do feed (grade 3 colunas color-coded por pilar, com
 *          badge de formato + gancho + loupe) + briefing por post
 *        → export PNG do mosaico (canvas puro) / HTML autocontido / texto.
 *
 * BYOK absoluto (Rule #1): a chave OpenRouter do próprio membro roda tudo, direto
 * do navegador → openrouter.ai. Nunca toca nosso backend.
 * COR-032: reroll em JSON inválido. COR-034/035: reasoning:{effort:'low'} (menos
 * deepseek) + rede p/ content vazio. COR-053: budget 16000 + headers ASCII.
 * COR-015: normaliza null-like. COR-044/047: wire por MutationObserver + picker.
 */
const App = (function () {
  'use strict';

  var wired = false;
  var lastPlan = null;   // { brief, plan }
  var activeTab = 'grade';

  // curated fallback pillar palette (distinct, harmonious on the graphite lightbox)
  var FALLBACK_COLORS = ['#c8654e', '#4e86c8', '#69b08a', '#c8a24a', '#9a6cc0', '#4bb0b6', '#d07aa0', '#7f8a56'];
  var FORMATS = ['Reels', 'Carrossel', 'Foto', 'Card', 'Citação'];

  function $(id) { return document.getElementById(id); }

  // ---------- field helpers ----------
  function cleanField(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).trim();
    var low = s.toLowerCase();
    if (low === 'null' || low === 'undefined' || low === 'n/a' || low === 'na' ||
        low === '-' || low === '—' || low === '') return '';
    return s;
  }
  function cleanArray(a) {
    if (!Array.isArray(a)) { var one = cleanField(a); return one ? [one] : []; }
    var out = []; a.forEach(function (x) { var c = cleanField(x); if (c) out.push(c); }); return out;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function txt(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }
  function isHex(s) { return /^#[0-9a-fA-F]{6}$/.test(String(s || '').trim()); }
  function normFormat(f) {
    var s = cleanField(f).toLowerCase();
    if (/reel|video|vídeo/.test(s)) return 'Reels';
    if (/carross|carou|slide/.test(s)) return 'Carrossel';
    if (/cita|quote|frase/.test(s)) return 'Citação';
    if (/card|texto|arte/.test(s)) return 'Card';
    if (/foto|imagem|photo|feed/.test(s)) return 'Foto';
    var c = cleanField(f);
    return c ? (c.charAt(0).toUpperCase() + c.slice(1)) : 'Foto';
  }

  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'toast' + (kind === 'err' ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 2600);
    setTimeout(function () { t.remove(); }, 3100);
  }

  // ---------- key / warning state ----------
  function syncKeyState() {
    var warn = $('no-key-warn');
    var btn = $('btn-generate');
    var okKeys = window.ApiKeyManager && ApiKeyManager.hasRequiredKeys();
    if (warn) warn.classList.toggle('show', !okKeys);
    if (btn) btn.disabled = !okKeys;
  }

  // ---------- JSON repair ladder (COR-032) ----------
  function stripToObject(s) {
    if (!s) return s;
    s = s.replace(/```(?:json)?/gi, '').replace(/```/g, '');
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    return s.trim();
  }
  function parseJSON(raw) {
    if (!raw) throw new Error('empty');
    var s = stripToObject(raw);
    var tries = [
      function (x) { return x; },
      function (x) { return x.replace(/,\s*([}\]])/g, '$1'); },
      function (x) { return x.replace(/[\x00-\x1f]+/g, ' '); },
      function (x) { return x.replace(/,\s*([}\]])/g, '$1').replace(/[\x00-\x1f]+/g, ' ').replace(/“|”/g, '"').replace(/‘|’/g, "'"); }
    ];
    var err;
    for (var i = 0; i < tries.length; i++) {
      try { return JSON.parse(tries[i](s)); } catch (e) { err = e; }
    }
    throw err || new Error('parse');
  }

  // ---------- LLM call (OpenRouter) ----------
  function fetchContent(messages, opts) {
    opts = opts || {};
    var active = ApiKeyManager.getActiveKey();
    if (!active) return Promise.reject(new Error('Nenhuma chave configurada.'));
    var model = ApiKeyManager.getModel();
    var isDeepSeek = model.indexOf('deepseek/') === 0;
    var body = {
      model: model,
      messages: messages,
      temperature: opts.temperature != null ? opts.temperature : 0.7,
      max_tokens: opts.maxTokens || 16000   // COR-053: reasoning models reason by default
    };
    if (!isDeepSeek && !opts.noReasoning) body.reasoning = { effort: 'low' };  // COR-034/035

    return fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + active.key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://feedia.maestrosdaia.com',
        'X-Title': 'Feed IA - Maestros da IA'   // ASCII only (COR-053 faq-ia)
      },
      body: JSON.stringify(body)
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (!resp.ok) {
          var em = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + resp.status);
          if (resp.status === 401) em = 'Chave OpenRouter inválida ou sem permissão.';
          if (resp.status === 402) em = 'Créditos insuficientes na sua conta OpenRouter (adicione em openrouter.ai/credits).';
          if (resp.status === 429) em = 'Muitas requisições — aguarde um instante e tente de novo.';
          var e = new Error(em); e.httpStatus = resp.status; throw e;
        }
        var choice = (data.choices && data.choices[0]) || {};
        var content = choice.message && choice.message.content;
        if (!content || !String(content).trim()) {
          var empty = new Error('Resposta vazia do modelo.'); empty.emptyContent = true; throw empty;
        }
        return String(content);
      });
    });
  }
  function fetchResilient(messages, opts) {
    return fetchContent(messages, opts).catch(function (e) {
      if (e && e.emptyContent) { return fetchContent(messages, Object.assign({}, opts, { noReasoning: true })); }
      throw e;
    });
  }

  // ---------- prompt ----------
  var TOM = {
    profissional: 'profissional e consultivo',
    descontraido: 'descontraído e próximo, como quem fala com amigos',
    inspirador: 'inspirador e motivacional',
    tecnico: 'técnico e de especialista, com autoridade',
    divertido: 'divertido e bem-humorado'
  };
  var OBJ = {
    crescer: 'crescer a audiência (alcance, novos seguidores, conteúdo compartilhável)',
    engajar: 'engajar a audiência atual (salvamentos, comentários, conversa)',
    vender: 'vender e converter (levar à ação, oferta, prova, urgência saudável)',
    autoridade: 'construir autoridade e confiança na marca',
    lancamento: 'sustentar um lançamento (aquecimento, antecipação, prova, chamada)'
  };

  function buildMessages(b) {
    var sys =
      'Você é um(a) social media strategist sênior brasileiro(a). Você planeja feeds de Instagram ' +
      'que equilibram pilares de conteúdo e formatos ao longo do mês, com estética coesa e resultado real. ' +
      'Escreva SEMPRE 100% em português do Brasil, com acentuação correta e SEM nenhuma palavra em inglês, ' +
      'EXCETO termos consagrados de redes sociais (Reels, Stories, feed, post, carrossel, CTA, hashtag, Close Friends). ' +
      'Não use emojis nos títulos dos tiles. Sua saída é EXCLUSIVAMENTE um objeto JSON válido ' +
      '(sem markdown, sem texto fora do JSON, aspas retas ").';

    var schema =
      '{\n' +
      '  "resumo": "1 parágrafo curto: a estratégia do feed do mês — por que essa grade serve ao objetivo.",\n' +
      '  "pilares": [ { "nome": "nome curto do pilar", "cor": "#RRGGBB (cores distintas e harmônicas entre si, boas sobre fundo escuro)" } ],\n' +
      '  "harmonia": "1 parágrafo curto: como a grade fica visualmente harmônica — ritmo de cores, formatos e pilares ao longo da grade.",\n' +
      '  "posts": [\n' +
      '    {\n' +
      '      "pilar": "nome EXATO de um dos pilares acima",\n' +
      '      "formato": "um de: Reels, Carrossel, Foto, Card, Citação",\n' +
      '      "titulo": "gancho curtíssimo que aparece no tile (2 a 5 palavras, sem emoji)",\n' +
      '      "legenda": "legenda pronta para publicar (1 a 2 frases, no tom pedido)",\n' +
      '      "cta": "chamada para ação curta (ex.: Salve este post, Comenta aqui, Chama no direct)",\n' +
      '      "conceito_visual": "o que a imagem ou vídeo deve mostrar (1 frase objetiva e visual)"\n' +
      '    }\n' +
      '  ]\n' +
      '}';

    var pilaresLinha = b.pilares.length
      ? 'Pilares definidos pelo gestor (use estes, pode refinar os nomes): ' + b.pilares.join('; ')
      : 'Pilares: sugira de 3 a 5 pilares adequados a este nicho e objetivo.';

    var user =
      'Planeje o feed de Instagram de ' + b.qtd + ' posts descrito abaixo.\n\n' +
      'Marca/perfil: ' + (b.marca || '(não informado)') + '\n' +
      'Nicho/segmento: ' + (b.nicho || '(não informado)') + '\n' +
      (b.tema ? 'Tema/foco do mês: ' + b.tema + '\n' : '') +
      'Objetivo do mês: ' + (OBJ[b.objetivo] || OBJ.engajar) + '\n' +
      'Tom de voz: ' + (TOM[b.tom] || TOM.descontraido) + '\n' +
      pilaresLinha + '\n' +
      (b.obs ? 'Observações do gestor (respeite): ' + b.obs + '\n' : '') +
      '\nRegras:\n' +
      '- O array "posts" DEVE ter EXATAMENTE ' + b.qtd + ' itens, na ORDEM DE PUBLICAÇÃO (o item 1 é o primeiro a publicar).\n' +
      '- Distribua os pilares e os formatos de forma equilibrada e alternada ao longo da grade (evite dois posts iguais em sequência).\n' +
      '- Cada post deve ser específico para ESTE nicho, tema e objetivo — nada genérico.\n' +
      '- "titulo" é o texto que aparece sobre o tile: curtíssimo e chamativo.\n' +
      '- "cor" de cada pilar: um hex #RRGGBB legível sobre fundo escuro; pilares diferentes = cores diferentes.\n' +
      'Responda somente com o JSON no formato:\n' + schema;

    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }

  // ---------- collect brief ----------
  function collectBrief() {
    var pilRaw = txt('f-pilares');
    var pilares = pilRaw ? pilRaw.split(/\n+/).map(function (x) { return cleanField(x); }).filter(Boolean) : [];
    return {
      marca: txt('f-marca'),
      nicho: txt('f-nicho'),
      tema: txt('f-tema'),
      qtd: parseInt(txt('f-qtd'), 10) || 12,
      objetivo: txt('f-objetivo') || 'engajar',
      pilares: pilares,
      tom: txt('f-tom') || 'descontraido',
      cor1: isHex($('f-cor1') && $('f-cor1').value) ? $('f-cor1').value : '#d7a54a',
      cor2: isHex($('f-cor2') && $('f-cor2').value) ? $('f-cor2').value : '#4e86c8',
      obs: txt('f-obs')
    };
  }

  // ---------- normalize plan ----------
  function normalizePlan(d, b) {
    d = d || {};
    // pillars + color map
    var rawP = Array.isArray(d.pilares) ? d.pilares : [];
    var pillars = [];
    var colorMap = {};
    var ci = 0;
    rawP.forEach(function (p) {
      var nome = cleanField(p && (p.nome || p.name || p));
      if (!nome) return;
      var cor = (p && isHex(p.cor)) ? p.cor : (p && isHex(p.cor_sugerida) ? p.cor_sugerida : FALLBACK_COLORS[ci % FALLBACK_COLORS.length]);
      ci++;
      if (!colorMap[nome.toLowerCase()]) { colorMap[nome.toLowerCase()] = cor; pillars.push({ nome: nome, cor: cor }); }
    });

    function colorFor(pilar) {
      var k = (pilar || '').toLowerCase();
      if (colorMap[k]) return colorMap[k];
      var c = FALLBACK_COLORS[Object.keys(colorMap).length % FALLBACK_COLORS.length];
      colorMap[k] = c;
      if (pilar) pillars.push({ nome: pilar, cor: c });
      return c;
    }

    var rawPosts = Array.isArray(d.posts) ? d.posts : (Array.isArray(d.tiles) ? d.tiles : []);
    var posts = rawPosts.map(function (p, i) {
      var pilar = cleanField(p && (p.pilar || p.pillar)) || (pillars[0] ? pillars[0].nome : 'Conteúdo');
      return {
        n: i + 1,
        pilar: pilar,
        cor: colorFor(pilar),
        formato: normFormat(p && p.formato),
        titulo: cleanField(p && (p.titulo || p.title || p.gancho)) || ('Post ' + (i + 1)),
        legenda: cleanField(p && (p.legenda || p.caption)),
        cta: cleanField(p && (p.cta || p.call_to_action)),
        conceito: cleanField(p && (p.conceito_visual || p.conceito || p.visual))
      };
    });

    return {
      resumo: cleanField(d.resumo || d.estrategia || d.resumo_executivo),
      harmonia: cleanField(d.harmonia || d.harmony),
      pilares: pillars,
      posts: posts
    };
  }

  // ---------- generate ----------
  function generate() {
    var b = collectBrief();
    if (!b.nicho && !b.marca) { toast('Preencha ao menos a marca ou o nicho.', 'err'); return; }
    if (!(window.ApiKeyManager && ApiKeyManager.hasRequiredKeys())) { syncKeyState(); toast('Adicione sua chave OpenRouter primeiro.', 'err'); return; }

    setBusy(true);
    var messages = buildMessages(b);

    var run = function () {
      return fetchResilient(messages, { temperature: 0.7, maxTokens: 16000 })
        .then(function (raw) {
          try { return parseJSON(raw); }
          catch (e) {
            var strict = messages.concat([
              { role: 'assistant', content: raw.slice(0, 400) },
              { role: 'user', content: 'Sua resposta anterior NÃO era um JSON válido. Responda NOVAMENTE apenas com o objeto JSON pedido, com aspas retas ("), sem markdown e sem texto fora do JSON.' }
            ]);
            return fetchResilient(strict, { temperature: 0.4, maxTokens: 16000 }).then(function (t2) { return parseJSON(t2); });
          }
        });
    };
    var wrapped = (window.RateLimiter && RateLimiter.executeWithLimit)
      ? RateLimiter.executeWithLimit('generate', run) : run();

    Promise.resolve(wrapped).then(function (data) {
      var plan = normalizePlan(data, b);
      if (!plan.posts.length) { setBusy(false); toast('O modelo não devolveu posts. Tente gerar novamente.', 'err'); return; }
      lastPlan = { brief: b, plan: plan };
      renderAll(lastPlan);
      setBusy(false);
    }).catch(function (e) {
      setBusy(false);
      var msg = (e && e.message) ? e.message : 'Erro ao montar a grade.';
      if (/rate limit exceeded|too many/i.test(msg)) msg = 'Muitas gerações seguidas. Aguarde um instante.';
      toast(msg, 'err');
      console.error('[feed-ia] generate error:', e);
    });
  }

  function setBusy(busy) {
    var btn = $('btn-generate');
    if (btn) {
      btn.disabled = busy || !(window.ApiKeyManager && ApiKeyManager.hasRequiredKeys());
      btn.querySelector('.btn-text').style.display = busy ? 'none' : 'inline';
      btn.querySelector('.btn-loading').style.display = busy ? 'inline' : 'none';
    }
    $('stage-loading').hidden = !busy;
    if (busy) {
      $('stage-empty').hidden = true; $('stage-toolbar').hidden = true;
      $('view-grade').hidden = true; $('view-brief').hidden = true;
      cycleLoading();
    }
  }
  var _loadTimer = null;
  function cycleLoading() {
    var steps = ['lendo o briefing', 'definindo os pilares', 'distribuindo os formatos', 'escrevendo os ganchos', 'montando o mosaico'];
    var i = 0; var el = $('loading-mono');
    if (_loadTimer) clearInterval(_loadTimer);
    _loadTimer = setInterval(function () {
      if (!el || $('stage-loading').hidden) { clearInterval(_loadTimer); return; }
      el.textContent = steps[i % steps.length] + '…'; i++;
    }, 900);
  }

  // ================= RENDER =================
  function fmtLabel(objetivo) {
    return { crescer: 'Crescimento', engajar: 'Engajamento', vender: 'Conversão', autoridade: 'Autoridade', lancamento: 'Lançamento' }[objetivo] || 'Feed';
  }

  function gridDims(qtd) {
    // 3 columns; rows = ceil(qtd/3)
    return { cols: 3, rows: Math.ceil(qtd / 3) };
  }

  function buildGradeHTML(r) {
    var b = r.brief, p = r.plan;
    var H = [];
    var handle = b.marca || b.nicho || 'Seu perfil';
    var meta = (b.tema ? b.tema + ' · ' : '') + p.posts.length + ' posts · ' + fmtLabel(b.objetivo);

    H.push('<div class="gallery" style="--frame:' + esc(b.cor1) + '">');
    H.push('<div class="wall" style="border-color:' + esc(b.cor1) + '">');
    H.push('<div class="mosaic">');
    p.posts.forEach(function (post) {
      H.push(
        '<div class="tile" style="background:' + esc(post.cor) + '">' +
          '<span class="tile-fmt">' + esc(post.formato) + '</span>' +
          '<span class="tile-num">' + post.n + '</span>' +
          '<div class="tile-hook">' + esc(post.titulo) + '</div>' +
          '<div class="tile-pilar">' + esc(post.pilar) + '</div>' +
          '<div class="tile-loupe">' +
            (post.legenda ? '<div><b>Legenda</b><span class="lp-legenda">' + esc(post.legenda) + '</span></div>' : '') +
            (post.cta ? '<div class="lp-cta">→ ' + esc(post.cta) + '</div>' : '') +
            (post.conceito ? '<div class="lp-vis">' + esc(post.conceito) + '</div>' : '') +
          '</div>' +
        '</div>'
      );
    });
    H.push('</div>'); // mosaic
    H.push('</div>'); // wall
    H.push('<div class="placard"><div class="p-handle">' + esc(handle) + '</div><div class="p-meta" style="color:' + esc(b.cor1) + '">' + esc(meta) + '</div></div>');
    H.push('</div>'); // gallery

    // legend
    if (p.pilares.length) {
      H.push('<div class="legend">');
      p.pilares.forEach(function (pl) {
        H.push('<span class="chip"><span class="dot" style="background:' + esc(pl.cor) + '"></span>' + esc(pl.nome) + '</span>');
      });
      H.push('</div>');
    }

    // notes
    if (p.resumo || p.harmonia) {
      H.push('<div class="notes">');
      if (p.resumo) H.push('<div class="note-card"><h4>Estratégia do mês</h4><p>' + esc(p.resumo) + '</p></div>');
      if (p.harmonia) H.push('<div class="note-card"><h4>Harmonia da grade</h4><p>' + esc(p.harmonia) + '</p></div>');
      H.push('</div>');
    }
    return H.join('');
  }

  function buildBriefHTML(r) {
    var p = r.plan;
    var H = ['<div class="brief-list">'];
    p.posts.forEach(function (post) {
      H.push(
        '<div class="brief-item" style="--bi-color:' + esc(post.cor) + '">' +
          '<div class="bi-index">' + post.n + '<small>post</small></div>' +
          '<div class="bi-body">' +
            '<div class="bi-tags">' +
              '<span class="tag fmt">' + esc(post.formato) + '</span>' +
              '<span class="tag pilar" style="background:' + esc(post.cor) + '">' + esc(post.pilar) + '</span>' +
            '</div>' +
            '<p class="bi-hook">' + esc(post.titulo) + '</p>' +
            (post.legenda ? '<p class="bi-legenda">' + esc(post.legenda) + '</p>' : '') +
            (post.cta ? '<p class="bi-line cta"><b>CTA:</b> ' + esc(post.cta) + '</p>' : '') +
            (post.conceito ? '<p class="bi-line"><b>Visual:</b> ' + esc(post.conceito) + '</p>' : '') +
          '</div>' +
        '</div>'
      );
    });
    H.push('</div>');
    return H.join('');
  }

  function renderAll(r) {
    $('view-grade').innerHTML = buildGradeHTML(r);
    $('view-brief').innerHTML = buildBriefHTML(r);
    $('stage-empty').hidden = true;
    $('stage-toolbar').hidden = false;
    $('tb-title').textContent = (r.brief.marca || r.brief.nicho || 'Grade do feed');
    var d = gridDims(r.plan.posts.length);
    $('tb-code').textContent = r.plan.posts.length + ' POSTS · ' + d.cols + '×' + d.rows + ' · ' + r.plan.pilares.length + ' PILARES';
    setTab(activeTab);
    if (window.matchMedia && window.matchMedia('(max-width: 980px)').matches) {
      $('stage-toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function setTab(tab) {
    activeTab = tab;
    $('tab-grade').classList.toggle('active', tab === 'grade');
    $('tab-brief').classList.toggle('active', tab === 'brief');
    $('view-grade').hidden = tab !== 'grade';
    $('view-brief').hidden = tab !== 'brief';
  }

  // ================= PNG EXPORT (pure canvas — no SVG foreignObject, COR-045 safe) =================
  function exportPNG() {
    if (!lastPlan) { toast('Monte uma grade primeiro.', 'err'); return; }
    try {
      var b = lastPlan.brief, p = lastPlan.plan;
      var scale = 2;
      var cols = 3, tile = 300, gap = 12, frame = 12, wallPad = 16, pad = 30;
      var rows = Math.ceil(p.posts.length / cols);
      var gridW = cols * tile + (cols - 1) * gap;
      var gridH = rows * tile + (rows - 1) * gap;
      var placardH = 74;
      var W = pad * 2 + wallPad * 2 + frame * 2 + gridW;
      var H = pad * 2 + wallPad * 2 + frame * 2 + gridH + placardH + 18;

      var cv = document.createElement('canvas');
      cv.width = W * scale; cv.height = H * scale;
      var g = cv.getContext('2d');
      g.scale(scale, scale);
      g.textBaseline = 'alphabetic';

      // background (lightbox)
      g.fillStyle = '#15161a'; g.fillRect(0, 0, W, H);

      // wall
      var wx = pad, wy = pad, ww = wallPad * 2 + frame * 2 + gridW, wh = wallPad * 2 + frame * 2 + gridH;
      roundRect(g, wx, wy, ww, wh, 12); g.fillStyle = '#0f1013'; g.fill();
      g.lineWidth = frame; g.strokeStyle = b.cor1;
      roundRect(g, wx + frame / 2, wy + frame / 2, ww - frame, wh - frame, 8); g.stroke();

      // tiles
      var ox = wx + frame + wallPad, oy = wy + frame + wallPad;
      p.posts.forEach(function (post, i) {
        var c = i % cols, rw = Math.floor(i / cols);
        var x = ox + c * (tile + gap), y = oy + rw * (tile + gap);
        drawTile(g, x, y, tile, post);
      });

      // placard
      var px = W / 2, py = wy + wh + 14;
      var handle = b.marca || b.nicho || 'Seu perfil';
      var meta = (b.tema ? b.tema + '  ·  ' : '') + p.posts.length + ' posts  ·  ' + fmtLabel(b.objetivo).toUpperCase();
      var plw = Math.min(W - pad * 2, 520), plx = (W - plw) / 2;
      roundRect(g, plx, py, plw, placardH - 8, 8); g.fillStyle = '#26282f'; g.fill();
      g.strokeStyle = b.cor1; g.lineWidth = 2; g.beginPath();
      g.moveTo(plx + 8, py); g.lineTo(plx + plw - 8, py); g.stroke();
      g.textAlign = 'center';
      g.fillStyle = '#ece7dc'; g.font = '700 18px ' + SANS;
      g.fillText(clip(g, handle, plw - 40), px, py + 27);
      g.fillStyle = b.cor1; g.font = '600 11px ' + MONO;
      g.fillText(clip(g, meta, plw - 30), px, py + 46);
      g.fillStyle = '#857f74'; g.font = '600 10px ' + MONO;
      g.fillText('FEED IA · MAESTROS DA IA', px, py + placardH - 8);
      g.textAlign = 'left';

      cv.toBlob(function (blob) {
        if (!blob) { toast('Não consegui gerar o PNG.', 'err'); return; }
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileBase() + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
        toast('Mosaico PNG baixado.');
      }, 'image/png');
    } catch (e) {
      console.error('[feed-ia] png error', e);
      toast('Não consegui gerar o PNG.', 'err');
    }
  }

  var SANS = '"Helvetica Neue",Arial,sans-serif';
  var MONO = 'ui-monospace,Menlo,Consolas,monospace';

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function clip(g, text, maxW) {
    text = String(text || '');
    if (g.measureText(text).width <= maxW) return text;
    var s = text;
    while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }
  function drawTile(g, x, y, size, post) {
    g.save();
    roundRect(g, x, y, size, size, 8); g.clip();
    // base color
    g.fillStyle = post.cor; g.fillRect(x, y, size, size);
    // vignette for legibility
    var grd = g.createLinearGradient(x, y, x, y + size);
    grd.addColorStop(0, 'rgba(0,0,0,0.05)');
    grd.addColorStop(0.45, 'rgba(0,0,0,0.12)');
    grd.addColorStop(1, 'rgba(0,0,0,0.62)');
    g.fillStyle = grd; g.fillRect(x, y, size, size);

    // format badge (top-left)
    g.font = '700 12px ' + MONO;
    var fmt = post.formato.toUpperCase();
    var fw = g.measureText(fmt).width + 16;
    roundRect(g, x + 10, y + 10, fw, 22, 5); g.fillStyle = 'rgba(0,0,0,0.36)'; g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(fmt, x + 18, y + 25);

    // number (top-right)
    g.font = '700 12px ' + MONO;
    var ns = String(post.n);
    var nw = g.measureText(ns).width + 14;
    roundRect(g, x + size - 10 - nw, y + 10, nw, 22, 5); g.fillStyle = 'rgba(0,0,0,0.32)'; g.fill();
    g.fillStyle = 'rgba(255,255,255,0.9)'; g.textAlign = 'center';
    g.fillText(ns, x + size - 10 - nw / 2, y + 25);
    g.textAlign = 'left';

    // pillar (small, above hook)
    g.font = '700 10px ' + MONO;
    g.fillStyle = 'rgba(255,255,255,0.82)';
    g.fillText(clip(g, post.pilar.toUpperCase(), size - 24), x + 14, y + size - 56);

    // hook (wrapped, bottom)
    g.fillStyle = '#fff'; g.font = '800 19px ' + SANS;
    wrapText(g, post.titulo, x + 14, y + size - 34, size - 28, 21, 2);

    g.restore();
  }
  function wrapText(g, text, x, y, maxW, lh, maxLines) {
    var words = String(text || '').split(/\s+/);
    var lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var test = cur ? cur + ' ' + words[i] : words[i];
      if (g.measureText(test).width > maxW && cur) { lines.push(cur); cur = words[i]; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = clip(g, lines[maxLines - 1] + '…', maxW); }
    var startY = y - (lines.length - 1) * lh;
    for (var j = 0; j < lines.length; j++) g.fillText(lines[j], x, startY + j * lh);
  }

  // ================= HTML EXPORT (self-contained) =================
  function exportHTML() {
    if (!lastPlan) { toast('Monte uma grade primeiro.', 'err'); return; }
    var doc = standaloneHTML(lastPlan);
    var blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileBase() + '.html';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    toast('Plano HTML baixado.');
  }
  function standaloneHTML(r) {
    var b = r.brief, p = r.plan;
    var handle = esc(b.marca || b.nicho || 'Seu perfil');
    var meta = esc((b.tema ? b.tema + ' · ' : '') + p.posts.length + ' posts · ' + fmtLabel(b.objetivo));
    var tiles = p.posts.map(function (post) {
      return '<div class="t" style="background:' + esc(post.cor) + '">' +
        '<span class="tf">' + esc(post.formato) + '</span><span class="tn">' + post.n + '</span>' +
        '<div class="th">' + esc(post.titulo) + '</div><div class="tp">' + esc(post.pilar) + '</div></div>';
    }).join('');
    var briefs = p.posts.map(function (post) {
      return '<div class="bi" style="border-left-color:' + esc(post.cor) + '">' +
        '<div class="bt"><span class="tag">' + esc(post.formato) + '</span><span class="tag pil" style="background:' + esc(post.cor) + '">' + esc(post.pilar) + '</span><span class="nn">#' + post.n + '</span></div>' +
        '<h4>' + esc(post.titulo) + '</h4>' +
        (post.legenda ? '<p>' + esc(post.legenda) + '</p>' : '') +
        (post.cta ? '<p class="cta">CTA: ' + esc(post.cta) + '</p>' : '') +
        (post.conceito ? '<p class="vis">Visual: ' + esc(post.conceito) + '</p>' : '') +
        '</div>';
    }).join('');
    var legend = p.pilares.map(function (pl) {
      return '<span class="lg"><span class="dot" style="background:' + esc(pl.cor) + '"></span>' + esc(pl.nome) + '</span>';
    }).join('');
    var cols = 3, rows = Math.ceil(p.posts.length / cols);
    var css =
      'body{margin:0;background:#15161a;color:#ece7dc;font-family:"Helvetica Neue",Arial,sans-serif;line-height:1.55;padding:26px}' +
      '.wrap{max-width:760px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}.sub{color:#857f74;font-family:ui-monospace,Menlo,monospace;font-size:12px;letter-spacing:.12em;text-transform:uppercase;margin:0 0 22px}' +
      '.wall{border:3px solid ' + esc(b.cor1) + ';border-radius:10px;padding:12px;background:#0f1013}' +
      '.mosaic{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.mosaic>*{min-width:0}' +
      '.t{position:relative;aspect-ratio:1;border-radius:6px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;padding:9px;color:#fff}' +
      '.t::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.6))}' +
      '.tf{position:absolute;top:7px;left:8px;font-family:ui-monospace,monospace;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;background:rgba(0,0,0,.36);border:1px solid rgba(255,255,255,.22);border-radius:4px;padding:2px 6px;z-index:2}' +
      '.tn{position:absolute;top:7px;right:8px;font-family:ui-monospace,monospace;font-size:10px;font-weight:700;background:rgba(0,0,0,.32);border-radius:4px;padding:1px 5px;z-index:2}' +
      '.th{position:relative;z-index:1;font-size:14px;font-weight:800;line-height:1.15;text-shadow:0 1px 6px rgba(0,0,0,.6)}.tp{position:relative;z-index:1;font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;opacity:.82;margin-top:4px}' +
      '.placard{max-width:520px;margin:16px auto 0;text-align:center;background:#26282f;border-top:2px solid ' + esc(b.cor1) + ';border-radius:8px;padding:12px 18px}.placard .h{font-weight:800;font-size:15px}.placard .m{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:' + esc(b.cor1) + ';margin-top:3px}' +
      '.legend{display:flex;flex-wrap:wrap;gap:8px 14px;justify-content:center;margin:18px 0}.lg{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:#b9b4a8}.dot{width:12px;height:12px;border-radius:3px}' +
      '.note{background:#1d1f26;border:1px solid #343946;border-left:3px solid ' + esc(b.cor1) + ';border-radius:9px;padding:14px 16px;margin:12px 0}.note h3{margin:0 0 6px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:' + esc(b.cor1) + ';font-family:ui-monospace,monospace}.note p{margin:0;color:#b9b4a8;font-size:14px}' +
      'h2{font-size:15px;letter-spacing:.1em;text-transform:uppercase;color:#857f74;margin:30px 0 12px;font-family:ui-monospace,monospace}' +
      '.bi{background:#1d1f26;border:1px solid #343946;border-left:4px solid #d7a54a;border-radius:9px;padding:14px 16px;margin-bottom:10px}.bi .bt{display:flex;gap:8px;align-items:center;margin-bottom:6px}.tag{font-family:ui-monospace,monospace;font-size:10px;font-weight:700;text-transform:uppercase;padding:3px 8px;border-radius:5px;background:#2b2f3a}.tag.pil{color:#fff}.nn{margin-left:auto;color:#857f74;font-family:ui-monospace,monospace;font-size:12px}.bi h4{margin:0 0 5px;font-size:15px}.bi p{margin:3px 0;color:#b9b4a8;font-size:13.5px}.bi .cta{color:#eabf6e}.bi .vis{color:#857f74}' +
      '.foot{margin-top:30px;text-align:center;color:#857f74;font-size:12px;border-top:1px solid #343946;padding-top:16px}';
    var notes = (p.resumo ? '<div class="note"><h3>Estratégia do mês</h3><p>' + esc(p.resumo) + '</p></div>' : '') +
                (p.harmonia ? '<div class="note"><h3>Harmonia da grade</h3><p>' + esc(p.harmonia) + '</p></div>' : '');
    return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Feed — ' + handle + '</title><style>' + css + '</style></head><body><div class="wrap">' +
      '<h1>' + handle + '</h1><p class="sub">' + meta + '</p>' +
      '<div class="wall"><div class="mosaic">' + tiles + '</div></div>' +
      '<div class="placard"><div class="h">' + handle + '</div><div class="m">' + meta + '</div></div>' +
      (legend ? '<div class="legend">' + legend + '</div>' : '') +
      notes +
      '<h2>Briefing por post (ordem de publicação)</h2>' + briefs +
      '<div class="foot">Gerado com Feed IA · Maestros da IA</div>' +
      '</div></body></html>';
  }

  // ================= COPY TEXT =================
  function copyText() {
    if (!lastPlan) { toast('Monte uma grade primeiro.', 'err'); return; }
    var b = lastPlan.brief, p = lastPlan.plan, L = [];
    L.push('PLANO DE FEED — ' + (b.marca || b.nicho || 'Perfil'));
    L.push((b.tema ? b.tema + ' · ' : '') + p.posts.length + ' posts · Objetivo: ' + fmtLabel(b.objetivo));
    if (p.pilares.length) L.push('Pilares: ' + p.pilares.map(function (x) { return x.nome; }).join(' · '));
    L.push('');
    if (p.resumo) { L.push('ESTRATÉGIA DO MÊS'); L.push(p.resumo); L.push(''); }
    L.push('GRADE (ordem de publicação):');
    p.posts.forEach(function (post) {
      L.push('');
      L.push('#' + post.n + ' — [' + post.formato + '] ' + post.pilar);
      L.push('Gancho: ' + post.titulo);
      if (post.legenda) L.push('Legenda: ' + post.legenda);
      if (post.cta) L.push('CTA: ' + post.cta);
      if (post.conceito) L.push('Visual: ' + post.conceito);
    });
    if (p.harmonia) { L.push(''); L.push('HARMONIA DA GRADE'); L.push(p.harmonia); }
    L.push('');
    L.push('— Gerado com Feed IA · Maestros da IA');
    var text = L.join('\n');
    var done = function () { toast('Plano copiado.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
    } else { fallbackCopy(text, done); }
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea'); ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(ta);
    ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Não consegui copiar.', 'err'); }
    ta.remove();
  }

  function fileBase() {
    var s = (lastPlan && (lastPlan.brief.marca || lastPlan.brief.nicho) ? (lastPlan.brief.marca || lastPlan.brief.nicho) : 'feed')
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return 'feed-' + (s || 'perfil');
  }

  // ---------- example / clear ----------
  function fillExample() {
    var set = function (id, v) { var el = $(id); if (el) el.value = v; };
    set('f-marca', '@padariapaoecia');
    set('f-nicho', 'Padaria artesanal de bairro');
    set('f-tema', 'Lançamento da linha de pães de fermentação natural');
    set('f-qtd', '12');
    set('f-objetivo', 'vender');
    set('f-pilares', 'Bastidores da produção\nEducação sobre fermentação\nProva social (clientes)\nOfertas e novidades');
    set('f-tom', 'descontraido');
    set('f-obs', 'Priorizar Reels; mostrar as mãos na massa; sábado tem feira do bairro.');
    if ($('f-cor1')) $('f-cor1').value = '#c8654e';
    if ($('f-cor2')) $('f-cor2').value = '#c8a24a';
    toast('Exemplo preenchido. Clique em Montar a grade.');
  }
  function clearForm() {
    ['f-marca', 'f-nicho', 'f-tema', 'f-pilares', 'f-obs'].forEach(function (id) { var el = $(id); if (el) el.value = ''; });
    $('f-qtd').value = '12'; $('f-objetivo').value = 'engajar'; $('f-tom').value = 'descontraido';
    if ($('f-cor1')) $('f-cor1').value = '#d7a54a';
    if ($('f-cor2')) $('f-cor2').value = '#4e86c8';
    $('f-marca').focus();
    toast('Formulário limpo.');
  }

  // ---------- wire ----------
  function wire() {
    if (wired) return;
    var app = $('app-screen');
    if (!app || !app.classList.contains('active')) return;
    wired = true;

    if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select'); // COR-047

    $('btn-generate').addEventListener('click', generate);
    $('btn-example').addEventListener('click', fillExample);
    $('btn-clear').addEventListener('click', clearForm);
    $('btn-png').addEventListener('click', exportPNG);
    $('btn-html').addEventListener('click', exportHTML);
    $('btn-copy').addEventListener('click', copyText);
    $('tab-grade').addEventListener('click', function () { setTab('grade'); });
    $('tab-brief').addEventListener('click', function () { setTab('brief'); });
    var okl = $('open-keys-link');
    if (okl) okl.addEventListener('click', function (e) { e.preventDefault(); var btn = $('manage-keys-btn'); if (btn) btn.click(); });

    syncKeyState();
  }

  function init() {
    window.addEventListener('maestria:app-ready', function () { wire(); syncKeyState(); });
    var app = $('app-screen');
    if (app) {
      var obs = new MutationObserver(function () {   // COR-044
        if (app.classList.contains('active')) { wire(); syncKeyState(); }
      });
      obs.observe(app, { attributes: true, attributeFilter: ['class'] });
    }
    if (app && app.classList.contains('active')) { wire(); syncKeyState(); }
  }

  return { init: init, syncKeyState: syncKeyState };
})();

window.App = App;
document.addEventListener('DOMContentLoaded', function () { App.init(); });
