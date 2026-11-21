// Kobuz Sites — publicador de subdomínios (roda no GitHub Actions do repositório PÚBLICO).
// Lê a fila do painel, valida o slug de novo e cria o subdomínio na Hostinger (o SSL é automático).
// O token da Hostinger existe só nos secrets do GitHub; nunca no servidor.
// Logs: nunca imprimir token nem corpo de resposta da API (repo público = logs públicos).
//
// Secrets:   APP_URL, QUEUE_KEY, HOSTINGER_API_TOKEN
// Variables: HOSTINGER_USERNAME (u873242798), HOSTINGER_DOMAIN (myapplabs.com.br),
//            SUBDOMAIN_DIR_PREFIX (p/  -> relativo ao public_html), DRY_RUN ("1" = só mostra, não cria)

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const APP_URL = env('APP_URL').replace(/\/$/, '');
const QUEUE_KEY = env('QUEUE_KEY');
const TOKEN = env('HOSTINGER_API_TOKEN');
const USERNAME = env('HOSTINGER_USERNAME', 'u873242798');
const DOMAIN = env('HOSTINGER_DOMAIN', 'myapplabs.com.br');
const DIR_PREFIX = env('SUBDOMAIN_DIR_PREFIX', 'p/');
const DRY_RUN = env('DRY_RUN', '1') !== '0';
const API = 'https://developers.hostinger.com';
// Endpoint oficial (developers.hostinger.com, "Create website subdomain" / "List website subdomains").
const SUBS_PATH = `/api/hosting/v1/accounts/${encodeURIComponent(USERNAME)}/websites/${encodeURIComponent(DOMAIN)}/subdomains`;

// Mesmas regras do painel (app/lib/render.php). Se mudar lá, mudar aqui.
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'sites', 'site', 'mail', 'email', 'smtp', 'imap', 'pop',
  'ftp', 'webmail', 'painel', 'panel', 'cpanel', 'hpanel', 'login', 'entrar', 'conta', 'contas', 'pix', 'banco',
  'bancos', 'gov', 'blog', 'templates', 'status', 'suporte', 'ajuda', 'help', 'dev', 'staging', 'teste', 'test',
  'ns1', 'ns2', 'cdn', 'static', 'assets', 'autodiscover', 'autoconfig', 'cobranca', 'pagamento', 'boleto']);
const BLOCKED = ['pix', 'gov', 'banco', 'bank', 'itau', 'bradesco', 'santander', 'caixa', 'nubank', 'picpay',
  'mercadopago', 'paypal', 'receita', 'detran', 'inss', 'serasa', 'senha', 'login', 'apple', 'google', 'microsoft',
  'whatsapp', 'instagram', 'facebook', 'kobuz', 'myapplabs', 'admin', 'correios', 'sicredi', 'sicoob'];

function validSlug(s) {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s) && !s.includes('--')
    && !RESERVED.has(s) && !BLOCKED.some((p) => s.includes(p));
}

async function painel(path, opts = {}) {
  const r = await fetch(APP_URL + path, {
    ...opts,
    headers: { 'X-Queue-Key': QUEUE_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`painel ${path}: HTTP ${r.status}`);
  return r.json();
}

/** Chama a Hostinger. Devolve o JSON só para uso interno; nada da resposta vai para o log. */
async function hostinger(method, body, path = SUBS_PATH) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`hostinger ${method}: HTTP ${r.status}`);
  try { return JSON.parse(text); } catch { return null; }
}

/** Mapa prefixo -> root_directory dos subdomínios já existentes. */
async function listSubdomains() {
  const list = await hostinger('GET');
  const map = new Map();
  for (const s of Array.isArray(list) ? list : []) {
    if (s && typeof s.subdomain === 'string') map.set(s.subdomain, String(s.root_directory || ''));
  }
  return map;
}

/** Lê o status da CDN como objeto (sem procurar texto). Resposta inesperada conta como "ligada", para tentar de novo. */
function cdnEnabled(res) {
  const o = res && typeof res === 'object' ? (res.data && typeof res.data === 'object' ? res.data : res) : null;
  if (!o) return true;
  if (typeof o.is_enabled === 'boolean') return o.is_enabled;
  if (typeof o.enabled === 'boolean') return o.enabled;
  if (typeof o.status === 'string') return ['active', 'enabled', 'on'].includes(o.status.toLowerCase());
  return true;
}

const expectedRoot = (slug) => `/public_html/${DIR_PREFIX}${slug}`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function report(id, status, erro = '') {
  await painel(`/api/fila/${id}`, { method: 'POST', body: JSON.stringify({ status, erro: String(erro).slice(0, 450) }) });
}

async function main() {
  if (!APP_URL.startsWith('https://') || QUEUE_KEY.length < 32) throw new Error('APP_URL/QUEUE_KEY ausentes');
  if (!DRY_RUN && TOKEN.length < 20) throw new Error('HOSTINGER_API_TOKEN ausente');
  if (!/^[a-z0-9/_-]*\/$/.test(DIR_PREFIX)) throw new Error('SUBDOMAIN_DIR_PREFIX inválido');
  const { itens = [] } = await painel('/api/fila');
  console.log(`Fila: ${itens.length} item(ns). DRY_RUN=${DRY_RUN}`);
  if (itens.length === 0) return;

  let existing = DRY_RUN ? new Map() : await listSubdomains();
  for (const { id, slug, acao } of itens) {
    if (!validSlug(slug)) {
      console.log(`#${id} recusado: slug inválido`);
      await report(id, 'erro', 'slug recusado pelo publicador');
      continue;
    }
    const fqdn = `${slug}.${DOMAIN}`;
    if (acao === 'remover') {
      // Site excluído pelo dono: só remove se o subdomínio aponta para a pasta das páginas (p/<slug>).
      if (DRY_RUN) {
        console.log(`#${id} [dry-run] removeria ${fqdn}`);
        continue;
      }
      try {
        if (existing.has(slug)) {
          if (!existing.get(slug).endsWith(expectedRoot(slug))) throw new Error('subdomínio aponta para outra pasta; não removido');
          await hostinger('DELETE', undefined, `${SUBS_PATH}/${encodeURIComponent(slug)}`);
          console.log(`#${id} removido: ${fqdn}`);
        } else {
          console.log(`#${id} já não existia: ${fqdn}`);
        }
        await report(id, 'feito');
      } catch (e) {
        console.log(`#${id} erro ao remover: ${e.message}`);
        await report(id, 'erro', e.message);
      }
      continue;
    }
    if (DRY_RUN) {
      console.log(`#${id} [dry-run] criaria ${fqdn} -> public_html/${DIR_PREFIX}${slug}`);
      continue;
    }
    try {
      if (existing.has(slug)) {
        if (!existing.get(slug).endsWith(expectedRoot(slug))) {
          throw new Error('subdomínio já existe apontando para outra pasta');
        }
        console.log(`#${id} já existia: ${fqdn}`);
      } else {
        await hostinger('POST', { subdomain: slug, directory: `${DIR_PREFIX}${slug}` });
        // A criação é assíncrona: confere na lista antes de avisar o painel.
        let ok = false;
        for (let t = 0; t < 6 && !ok; t++) {
          await sleep(5000);
          existing = await listSubdomains();
          ok = existing.has(slug) && existing.get(slug).endsWith(expectedRoot(slug));
        }
        if (!ok) throw new Error('subdomínio não apareceu na lista após a criação');
        console.log(`#${id} criado: ${fqdn}`);
      }
      // Sem CDN nas páginas: o endereço passa a responder direto do servidor (já com SSL) em minutos,
      // e uma nova publicação aparece na hora. Falha aqui não impede a publicação.
      // Num subdomínio recém-criado a Hostinger pode religar a CDN logo depois: confere e repete.
      const cdnBase = `/api/hosting/v1/accounts/${encodeURIComponent(USERNAME)}/websites/${encodeURIComponent(fqdn)}/cdn`;
      let cdnOff = false;
      for (let t = 0; t < 4 && !cdnOff; t++) {
        try {
          await hostinger('POST', undefined, `${cdnBase}/disable`);
          await sleep(20000);
          cdnOff = !cdnEnabled(await hostinger('GET', undefined, `${cdnBase}/status`));
        } catch (e) {
          console.log(`#${id} aviso: CDN (${e.message})`);
          await sleep(10000);
        }
      }
      console.log(`#${id} CDN ${cdnOff ? 'desligada e conferida' : 'NÃO confirmada como desligada'}`);
      await report(id, 'feito');
    } catch (e) {
      console.log(`#${id} erro: ${e.message}`);
      await report(id, 'erro', e.message);
    }
  }
}

main().catch((e) => { const m = String(e.message); console.error(TOKEN ? m.split(TOKEN).join('***') : m); process.exit(1); });
