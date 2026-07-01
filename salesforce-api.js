/**
 * ═══════════════════════════════════════════════════════════════
 *  Meu Crediário — Salesforce API Integration
 *  Espelha exatamente o modelo de dados do Salesforce_v1.pbix
 *
 *  Tabelas identificadas no .pbix:
 *    f1Lead      → Lead (objeto Salesforce)
 *    f2Oport     → Opportunity (objeto Salesforce)
 *    dDono       → Owner (lookup em Lead/Oport)
 *    dUTM        → Campos UTM no Lead
 *    dStatus     → Status do Lead
 *    dStage      → StageName da Opportunity
 *    dQual_Ramo  → Campo de segmento/ramo
 *    dQual_Fat   → Faixa de faturamento
 *    dQual_Cred  → Tipo de crediário
 *    dQual_QntLj → Quantidade de lojas
 *    #Medidas    → KPIs calculados aqui em JS
 * ═══════════════════════════════════════════════════════════════
 */

// ─── CONFIGURAÇÃO ────────────────────────────────────────────
const SF = {
  INSTANCE_URL: 'https://meucrediario.my.salesforce.com',
  CLIENT_ID:    '3MVG9HB6vm3GZZR8FAYJxufmYBeoBcc6.c9Wpe_fdP4G8niPuZ5rplPHPHU_V7gTrKU4unDGWaYtm5FrvgGhW',
  REDIRECT_URI:  'https://faubin-meucrediario.github.io/dashboard-mc/dashboard-tv.html',
  API_VERSION:  'v62.0',
  MOCK_MODE:     false,
};

// ─── CAMPOS UTM: ajuste para os nomes da sua org ─────────────
// No .pbix: dUTM.UTM_G, dUTM.UTM_G1, dUTM.UTM_G2, dUTM.UTM*
// Mapeie aqui para os API Names reais do seu objeto Lead:
const UTM_FIELDS = {
  UTM_G:  'UTM_G__c',    // utm_source agrupado (instagram, facebook, organic…)
  UTM_G1: 'UTM_G1__c',   // utm_medium (ads, organic, outbound…)
  UTM_G2: 'UTM_G2__c',   // utm_campaign (nome da campanha)
  UTM:    'UTM__c',       // utm completo concatenado
};

// ─── CAMPOS QUALIFICAÇÃO: ajuste para os nomes da sua org ────
const QUAL_FIELDS = {
  Ramo:   'RamoGr__c',    // dQual_Ramo.RamoGr  — ramo/segmento
  Fat:    'Fat__c',        // dQual_Fat.Fat       — faixa de faturamento
  Cred:   'Cred__c',       // dQual_Cred.Cred     — tipo de crediário
  QntLj:  'QntLj__c',      // dQual_QntLj.QntLj  — número de lojas
};

// ─── CAMPOS STATUS/STAGE ─────────────────────────────────────
// Status do Lead que representam "Ganho" (SDR converteu):
const LEAD_WON_STATUS = ['Converted', 'Qualificado', 'Oportunidade Aberta'];
// Status do Lead que representam "Perdido":
const LEAD_LOST_STATUS = ['Closed - Not Converted', 'Descartado', 'Sem Contato'];

// ═══════════════════════════════════════════════════════════════
//  OAUTH 2.0 — Implicit Flow (sem backend necessário)
// ═══════════════════════════════════════════════════════════════
const Auth = {
  getToken() {
    return sessionStorage.getItem('sf_access_token');
  },

  saveToken(token, instance) {
    sessionStorage.setItem('sf_access_token', token);
    if (instance) sessionStorage.setItem('sf_instance_url', instance);
  },

  getInstanceUrl() {
    return sessionStorage.getItem('sf_instance_url') || SF.INSTANCE_URL;
  },

  isAuthenticated() {
    return !!this.getToken();
  },

  login() {
    const authUrl = `${SF.INSTANCE_URL}/services/oauth2/authorize`
      + `?response_type=token`
      + `&client_id=${encodeURIComponent(SF.CLIENT_ID)}`
      + `&redirect_uri=${encodeURIComponent(SF.REDIRECT_URI)}`
      + `&scope=api`;
    window.location.href = authUrl;
  },

  logout() {
    sessionStorage.removeItem('sf_access_token');
    sessionStorage.removeItem('sf_instance_url');
  },

  // Chame no início da página para capturar o token do callback OAuth
  handleCallback() {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access_token')) return false;
    const params = new URLSearchParams(hash.substring(1));
    const token    = params.get('access_token');
    const instance = params.get('instance_url');
    if (token) {
      this.saveToken(token, instance);
      // Limpa o hash da URL sem recarregar a página
      history.replaceState(null, '', window.location.pathname);
      return true;
    }
    return false;
  },
};

// ═══════════════════════════════════════════════════════════════
//  SOQL QUERY ENGINE
// ═══════════════════════════════════════════════════════════════
async function soql(query) {
  const token       = Auth.getToken();
  const instanceUrl = Auth.getInstanceUrl();
  const url = `${instanceUrl}/services/data/${SF.API_VERSION}/query?q=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    // Token expirado → força novo login
    if (response.status === 401) {
      Auth.logout();
      throw new Error('TOKEN_EXPIRED');
    }
    throw new Error(err[0]?.message || `SOQL error ${response.status}`);
  }

  const data = await response.json();
  // Paginar automaticamente se houver mais registros
  let records = data.records;
  let nextUrl = data.nextRecordsUrl;
  while (nextUrl) {
    const next = await fetch(`${instanceUrl}${nextUrl}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const nextData = await next.json();
    records = records.concat(nextData.records);
    nextUrl = nextData.nextRecordsUrl;
  }
  return records;
}

// ═══════════════════════════════════════════════════════════════
//  QUERIES — espelham exatamente as medidas do .pbix
// ═══════════════════════════════════════════════════════════════

/**
 * f1Lead → Lead
 * Retorna todos os leads com campos de qualificação e UTM
 * Período: últimos N dias ou ano atual
 */
async function queryLeads(days = 365) {
  const dateFilter = days === 'ytd'
    ? `CALENDAR_YEAR(CreatedDate) = ${new Date().getFullYear()}`
    : `CreatedDate = LAST_N_DAYS:${days}`;

  const q = `
    SELECT
      Id,
      CreatedDate,
      Status,
      OwnerId,
      Owner.Name,
      ${UTM_FIELDS.UTM_G},
      ${UTM_FIELDS.UTM_G1},
      ${UTM_FIELDS.UTM_G2},
      ${UTM_FIELDS.UTM},
      ${QUAL_FIELDS.Ramo},
      ${QUAL_FIELDS.Fat},
      ${QUAL_FIELDS.Cred},
      ${QUAL_FIELDS.QntLj},
      IsConverted,
      ConvertedDate,
      ConvertedOpportunityId,
      LeadSource
    FROM Lead
    WHERE ${dateFilter}
    ORDER BY CreatedDate DESC
  `;
  return soql(q);
}

/**
 * f2Oport → Opportunity
 * Retorna oportunidades com estágio, valor e datas
 */
async function queryOpportunities(days = 365) {
  const dateFilter = days === 'ytd'
    ? `CALENDAR_YEAR(CreatedDate) = ${new Date().getFullYear()}`
    : `CreatedDate = LAST_N_DAYS:${days}`;

  const q = `
    SELECT
      Id,
      Name,
      StageName,
      Amount,
      MRR__c,
      Setup__c,
      CloseDate,
      CreatedDate,
      IsClosed,
      IsWon,
      OwnerId,
      Owner.Name,
      LeadSource,
      ${QUAL_FIELDS.Ramo},
      ${QUAL_FIELDS.Fat},
      ${QUAL_FIELDS.Cred},
      ${QUAL_FIELDS.QntLj}
    FROM Opportunity
    WHERE ${dateFilter}
    ORDER BY CreatedDate DESC
  `;
  return soql(q);
}

/**
 * Agrupamento para metas — equivale às páginas de Resumo Metas
 * Retorna contagens por mês
 */
async function queryLeadsByMonth(year) {
  const q = `
    SELECT
      CALENDAR_MONTH(CreatedDate) Mes,
      CALENDAR_YEAR(CreatedDate) Ano,
      COUNT(Id) Total,
      SUM(CASE WHEN IsConverted = true THEN 1 ELSE 0 END) Convertidos
    FROM Lead
    WHERE CALENDAR_YEAR(CreatedDate) >= ${year - 1}
      AND CALENDAR_YEAR(CreatedDate) <= ${year}
    GROUP BY CALENDAR_MONTH(CreatedDate), CALENDAR_YEAR(CreatedDate)
    ORDER BY CALENDAR_YEAR(CreatedDate), CALENDAR_MONTH(CreatedDate)
  `;
  return soql(q);
}

/**
 * UTM Analytics — espelha páginas 9–12 do .pbix
 * Agrupa por UTM_G (source) e UTM_G1 (medium/campaign)
 */
async function queryUTMAnalytics(days = 365) {
  const dateFilter = `CreatedDate = LAST_N_DAYS:${days}`;
  const q = `
    SELECT
      ${UTM_FIELDS.UTM_G},
      ${UTM_FIELDS.UTM_G1},
      ${UTM_FIELDS.UTM_G2},
      COUNT(Id) TotalLeads,
      SUM(CASE WHEN IsConverted = true THEN 1 ELSE 0 END) LeadsConvertidos
    FROM Lead
    WHERE ${dateFilter}
      AND ${UTM_FIELDS.UTM_G} != null
    GROUP BY ${UTM_FIELDS.UTM_G}, ${UTM_FIELDS.UTM_G1}, ${UTM_FIELDS.UTM_G2}
    ORDER BY TotalLeads DESC
    LIMIT 50
  `;
  return soql(q);
}

/**
 * Pipeline por Estágio — para o Funil do Slide 1
 */
async function queryPipelineByStage() {
  const q = `
    SELECT
      StageName,
      COUNT(Id) Total,
      SUM(Amount) ValorTotal
    FROM Opportunity
    WHERE IsClosed = false
    GROUP BY StageName
    ORDER BY SUM(Amount) DESC
  `;
  return soql(q);
}

/**
 * Performance por Vendedor (dDono, dDonoCom, dDonoSDR)
 */
async function queryByOwner(days = 365) {
  const dateFilter = `CreatedDate = LAST_N_DAYS:${days}`;
  const qLeads = `
    SELECT
      Owner.Name,
      COUNT(Id) TotalLeads,
      SUM(CASE WHEN IsConverted = true THEN 1 ELSE 0 END) Convertidos
    FROM Lead
    WHERE ${dateFilter}
    GROUP BY Owner.Name
    ORDER BY TotalLeads DESC
  `;
  const qOport = `
    SELECT
      Owner.Name,
      COUNT(Id) TotalOport,
      SUM(CASE WHEN IsWon = true THEN 1 ELSE 0 END) Ganhas,
      SUM(CASE WHEN IsWon = true THEN Amount ELSE 0 END) ValorGanho
    FROM Opportunity
    WHERE ${dateFilter}
    GROUP BY Owner.Name
    ORDER BY TotalOport DESC
  `;
  const [leads, oport] = await Promise.all([soql(qLeads), soql(qOport)]);
  return { leads, oport };
}

// ═══════════════════════════════════════════════════════════════
//  TRANSFORM — converte registros Salesforce nos dados do dashboard
//  Espelha as medidas DAX do .pbix:
//    $L     = COUNT(Lead)
//    $LC    = COUNT(Lead WHERE IsConverted = true)
//    $L%C   = $LC / $L
//    $Op    = COUNT(Opportunity)
//    $OpC   = COUNT(Opportunity WHERE IsWon = true)
//    $Op%C  = $OpC / $Op
//    $ValorMRR   = SUM(MRR__c WHERE IsWon)
//    $ValorSetup = SUM(Setup__c WHERE IsWon)
//    $ValorTotal = SUM(Amount WHERE IsWon)
// ═══════════════════════════════════════════════════════════════
function computeKPIs(leads, opportunities) {
  const $L    = leads.length;
  const $LC   = leads.filter(l => l.IsConverted).length;
  const $Op   = opportunities.length;
  const $OpC  = opportunities.filter(o => o.IsWon).length;
  const $OpP  = opportunities.filter(o => o.IsClosed && !o.IsWon).length;

  const $ValorTotal = opportunities
    .filter(o => o.IsWon)
    .reduce((s, o) => s + (o.Amount || 0), 0);
  const $ValorMRR = opportunities
    .filter(o => o.IsWon)
    .reduce((s, o) => s + (o.MRR__c || 0), 0);
  const $ValorSetup = opportunities
    .filter(o => o.IsWon)
    .reduce((s, o) => s + (o.Setup__c || 0), 0);

  const openOport = opportunities.filter(o => !o.IsClosed);

  return {
    // f1Lead medidas
    $L,
    $LC,
    '$L%C': $L > 0 ? ($LC / $L * 100).toFixed(1) + '%' : '0%',

    // f2Oport medidas
    $Op,
    $OpC,
    $OpP,
    '$Op%C': $Op > 0 ? ($OpC / $Op * 100).toFixed(1) + '%' : '0%',
    pipelineCount: openOport.length,
    pipelineValue: openOport.reduce((s, o) => s + (o.Amount || 0), 0),

    // #Medidas-V
    $ValorTotal,
    $ValorMRR,
    $ValorSetup,

    // Funil completo
    funnelLost: $L - $LC,
    funnelLostPct: $L > 0 ? ((($L - $LC) / $L) * 100).toFixed(0) + '%' : '0%',
  };
}

/**
 * Agrupa leads por mês para os gráficos de tendência
 * Retorna array de { mes: 'jan/25', total, convertidos }
 */
function groupByMonth(leads) {
  const map = {};
  leads.forEach(l => {
    const d = new Date(l.CreatedDate);
    const key = `${d.toLocaleString('pt-BR', { month: 'short' })}/${String(d.getFullYear()).slice(2)}`;
    if (!map[key]) map[key] = { mes: key, total: 0, convertidos: 0, timestamp: d.getFullYear() * 100 + d.getMonth() };
    map[key].total++;
    if (l.IsConverted) map[key].convertidos++;
  });
  return Object.values(map).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Agrupa por campo de dimensão (Ramo, Fat, Cred, QntLj)
 */
function groupByDimension(records, field) {
  const map = {};
  records.forEach(r => {
    const key = r[field] || 'N/A';
    if (!map[key]) map[key] = { label: key, total: 0, convertidos: 0 };
    map[key].total++;
    if (r.IsConverted || r.IsWon) map[key].convertidos++;
  });
  return Object.values(map).sort((a, b) => b.total - a.total);
}

/**
 * Processa dados UTM — espelha dUTM.UTM_G, UTM_G1, UTM_G2
 */
function processUTM(leads) {
  const map = {};
  leads.forEach(l => {
    const g  = l[UTM_FIELDS.UTM_G]  || 'direct';
    const g1 = l[UTM_FIELDS.UTM_G1] || '';
    const g2 = l[UTM_FIELDS.UTM_G2] || '';
    const key = `${g}||${g1}||${g2}`;
    if (!map[key]) map[key] = { UTM_G: g, UTM_G1: g1, UTM_G2: g2, total: 0, convertidos: 0, oport: 0 };
    map[key].total++;
    if (l.IsConverted) {
      map[key].convertidos++;
      if (l.ConvertedOpportunityId) map[key].oport++;
    }
  });
  return Object.values(map)
    .sort((a, b) => b.total - a.total)
    .map(r => ({
      ...r,
      '$L%C': r.total > 0 ? (r.convertidos / r.total * 100).toFixed(0) + '%' : '0%',
      '$Op%C': r.oport > 0 ? (r.oport / r.convertidos * 100).toFixed(0) + '%' : '—',
      '$Op%CALL': r.oport > 0 ? (r.oport / r.total * 100).toFixed(1) + '%' : '—',
    }));
}

// ═══════════════════════════════════════════════════════════════
//  ENTRY POINT — carrega tudo e devolve objeto pronto para o dashboard
// ═══════════════════════════════════════════════════════════════
async function loadDashboardData(period = '30d') {
  const days = { '7d': 7, '30d': 30, '90d': 90, 'ytd': 'ytd', 'ano': 365 }[period] || 30;

  const [leads, opportunities] = await Promise.all([
    queryLeads(days),
    queryOpportunities(days),
  ]);

  const kpis           = computeKPIs(leads, opportunities);
  const leadsByMonth   = groupByMonth(leads);
  const byRamo         = groupByDimension(leads, QUAL_FIELDS.Ramo);
  const byFat          = groupByDimension(leads, QUAL_FIELDS.Fat);
  const byCred         = groupByDimension(leads, QUAL_FIELDS.Cred);
  const byQntLj        = groupByDimension(leads, QUAL_FIELDS.QntLj);
  const utmData        = processUTM(leads);
  const pipelineStages = await queryPipelineByStage();
  const byOwner        = await queryByOwner(days);

  return {
    kpis,
    leadsByMonth,
    byRamo,
    byFat,
    byCred,
    byQntLj,
    utmData,
    pipelineStages,
    byOwner,
    raw: { leads, opportunities },
  };
}

// ═══════════════════════════════════════════════════════════════
//  MOCK DATA — substitui a chamada real quando MOCK_MODE = true
//  Baseado nos valores reais observados nas telas do Power BI
// ═══════════════════════════════════════════════════════════════
function getMockData() {
  const MESES = ['jan/25','fev/25','mar/25','abr/25','mai/25','jun/25',
                 'jul/25','ago/25','set/25','out/25','nov/25','dez/25',
                 'jan/26','fev/26','mar/26','abr/26','mai/26','jun/26'];
  const ML    = [1083,1343,1471,1780,1807,1709,1913,2916,2008,2400,2625,2672,3094,3183,2871,3024,2833,2625];
  const MC    = [216,269,294,356,361,342,383,584,402,480,525,534,619,637,574,605,567,525];

  return {
    kpis: {
      $L: 5533, $LC: 991, '$L%C': '17%',
      $Op: 1027, $OpC: 277, $OpP: 746, '$Op%C': '24%',
      pipelineCount: 249, pipelineValue: 2_400_000,
      $ValorTotal: 413_000_000, $ValorMRR: 173_000_000, $ValorSetup: 240_000_000,
      funnelLost: 4436, funnelLostPct: '84%',
    },
    leadsByMonth: MESES.map((mes, i) => ({
      mes,
      total: ML[i],
      convertidos: MC[i],
      timestamp: i,
    })),
    byRamo: [
      { label: 'Moda&Esporte',   total: 759, convertidos: 180 },
      { label: 'Móveis&Eletro',  total: 442, convertidos:  94 },
      { label: 'Cel&Inform',     total: 430, convertidos:  37 },
      { label: 'Ótica',          total: 260, convertidos:  76 },
      { label: 'Farma&Perfume',  total: 181, convertidos:  31 },
      { label: 'MaterialConst',  total: 156, convertidos:  23 },
    ],
    byFat: [
      { label: 'Até 15mil',     total: 156, convertidos:  17 },
      { label: '15mil-30mil',   total: 916, convertidos: 115 },
      { label: '30mil-75mil',   total: 679, convertidos: 159 },
      { label: '75mil-150mil',  total: 349, convertidos:  79 },
      { label: 'Acima 150mil',  total: 315, convertidos:  88 },
    ],
    byCred: [
      { label: 'Próprio',    total: 1151, convertidos: 290 },
      { label: 'Não vende',  total: 1027, convertidos: 134 },
      { label: 'Financeira', total:  237, convertidos:  34 },
    ],
    byQntLj: [
      { label: '1 Lj',       total: 1755, convertidos: 337 },
      { label: '2-5 Ljs',    total:  571, convertidos: 103 },
      { label: '6-10 Ljs',   total:   42, convertidos:  11 },
      { label: 'Acima 10',   total:   39, convertidos:   7 },
      { label: 'Online',     total:    8, convertidos:   1 },
    ],
    utmData: [
      { UTM_G:'instagram', UTM_G1:'ads', UTM_G2:'ig-ads-pub1+27-C',  total: 999, convertidos:125, oport:127, '$L%C':'13%', '$Op%C':'19%', '$Op%CALL':'2.4%' },
      { UTM_G:'instagram', UTM_G1:'ads', UTM_G2:'ig-ads-rmkt',       total:1531, convertidos:158, oport:158, '$L%C':'10%', '$Op%C':'9%',  '$Op%CALL':'1.0%' },
      { UTM_G:'instagram', UTM_G1:'ads', UTM_G2:'ig-ads-pub1+27-A',  total: 672, convertidos: 79, oport: 81, '$L%C':'12%', '$Op%C':'14%', '$Op%CALL':'1.6%' },
      { UTM_G:'instagram', UTM_G1:'ads', UTM_G2:'ig-ads-pub1+27-B',  total: 346, convertidos: 36, oport: 38, '$L%C':'10%', '$Op%C':'24%', '$Op%CALL':'2.6%' },
      { UTM_G:'organic',   UTM_G1:'organic', UTM_G2:'pesquisa',      total: 530, convertidos:215, oport:212, '$L%C':'41%', '$Op%C':'30%', '$Op%CALL':'12.1%'},
      { UTM_G:'organic',   UTM_G1:'organic', UTM_G2:'site-bot',      total: 146, convertidos: 84, oport: null,'$L%C':'58%', '$Op%C':'—',   '$Op%CALL':'—'   },
    ],
    pipelineStages: [
      { StageName:'Prospecção',    Total:54, ValorTotal: 320000 },
      { StageName:'Agendamento',   Total:26, ValorTotal: 480000 },
      { StageName:'Demonstração',  Total:100,ValorTotal: 640000 },
      { StageName:'Negociação',    Total:21, ValorTotal: 520000 },
      { StageName:'Env. Contrato', Total:110,ValorTotal: 440000 },
      { StageName:'Fechamento',    Total:18, ValorTotal: 380000 },
    ],
    byOwner: {
      leads: [
        { 'Owner.Name':'Matheus', TotalLeads:448, Convertidos:117 },
        { 'Owner.Name':'Raquel',  TotalLeads:301, Convertidos: 39 },
        { 'Owner.Name':'SDR',     TotalLeads:  4, Convertidos:  0 },
      ],
      oport: [
        { 'Owner.Name':'Ully',    TotalOport: 82, Ganhas: 72, ValorGanho: 33_700_000 },
        { 'Owner.Name':'Marcelo', TotalOport: 14, Ganhas:  6, ValorGanho: 14_100_000 },
        { 'Owner.Name':'Eliana',  TotalOport: 12, Ganhas:  1, ValorGanho:  9_200_000 },
      ],
    },
  };
}

// ═══════════════════════════════════════════════════════════════
//  API PÚBLICA — use esta função no dashboard-tv.html
// ═══════════════════════════════════════════════════════════════
const SalesforceAPI = {
  Auth,

  /**
   * Inicializa: captura callback OAuth se vier de redirect
   * Retorna true se autenticado, false se não
   */
  init() {
    Auth.handleCallback();
    return SF.MOCK_MODE || Auth.isAuthenticated();
  },

  /**
   * Carrega dados para o dashboard
   * Se MOCK_MODE=true: retorna dados mockados
   * Se autenticado: busca do Salesforce
   * Se não autenticado: lança para login
   */
  async getData(period = '30d') {
    if (SF.MOCK_MODE) {
      await new Promise(r => setTimeout(r, 400)); // simula latência
      return getMockData();
    }
    if (!Auth.isAuthenticated()) {
      throw new Error('NOT_AUTHENTICATED');
    }
    return loadDashboardData(period);
  },

  /**
   * Força sincronização (botão Sincronizar)
   */
  async sync(period = '30d') {
    if (SF.MOCK_MODE) {
      alert(
        '⚙️ Para conectar ao Salesforce:\n\n' +
        '1. Abra o arquivo SALESFORCE_SETUP.md\n' +
        '2. Crie o Connected App (5 min)\n' +
        '3. Cole o Consumer Key em SF.CLIENT_ID\n' +
        '4. Ajuste os API Names dos campos UTM\n' +
        '   (UTM_FIELDS e QUAL_FIELDS neste arquivo)\n' +
        '5. Mude SF.MOCK_MODE para false\n\n' +
        'Os campos UTM identificados no seu .pbix:\n' +
        '  UTM_G → ' + UTM_FIELDS.UTM_G + '\n' +
        '  UTM_G1 → ' + UTM_FIELDS.UTM_G1 + '\n' +
        '  UTM_G2 → ' + UTM_FIELDS.UTM_G2
      );
      return;
    }
    if (!Auth.isAuthenticated()) {
      Auth.login();
      return;
    }
    return loadDashboardData(period);
  },

  /**
   * Retorna string de status para a UI
   */
  getStatus() {
    if (SF.MOCK_MODE) return { text: 'Dados Mockados', color: '#F5A623', icon: '⚠' };
    if (Auth.isAuthenticated()) return { text: 'Salesforce · Conectado', color: '#22A05F', icon: '●' };
    return { text: 'Clique para conectar', color: '#C0271E', icon: '○' };
  },
};

// Exporta para uso no dashboard
if (typeof module !== 'undefined') module.exports = SalesforceAPI;
