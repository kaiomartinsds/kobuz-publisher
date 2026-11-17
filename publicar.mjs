// Kobuz Sites — publicador de subdomínios (roda no GitHub Actions do repositório PÚBLICO).
// Lê a fila do painel, valida o slug de novo e cria o subdomínio + SSL na Hostinger.
// O token da Hostinger existe só nos secrets do GitHub; nunca no servidor.
//
// Secrets: APP_URL, QUEUE_KEY, HOSTINGER_API_TOKEN
// Logs: nunca imprimir token nem corpo de resposta da API (repo público = logs públicos).
// Variables: HOSTINGER_DOMAIN (myapplabs.com.br), SUBDOMAIN_DIR_PREFIX (ex.: public_html/p/),
//            HOSTINGER_ADD_DOMAIN_PATH, HOSTINGER_SSL_PATH, DRY_RUN ("1" = só mostra, não cria)
// (SUBDOMAIN_DIR_PREFIX padrão: p/)

const env = (k, d = '') => (process.env[k] ?? d).trim();
const APP_URL = env('APP_URL').replace(/\/$/, '');
const QUEUE_KEY = env('QUEUE_KEY');
const TOKEN = env('HOSTINGER_API_TOKEN');
const DOMAIN = env('HOSTINGER_DOMAIN', 'myapplabs.com.br');
// Pasta do subdomínio RELATIVA AO public_html (confirmado na Hostinger): 'p/' -> public_html/p/<slug>.
const DIR_PREFIX = env('SUBDOMAIN_DIR_PREFIX', 'p/');
const API = 'https://developers.hostinger.com';
// Caminhos REST da Hostinger: CONFIRMAR em developers.hostinger.com antes de desligar o DRY_RUN.
// Equivalem às operações hosting_websites_add-domain e hosting_ssl_install.
const ADD_PATH = env('HOSTINGER_ADD_DOMAIN_PATH', '/api/hosting/v1/websites/{domain}/domains');
const SSL_PATH = env('HOSTINGER_SSL_PATH', '');
const DRY_RUN = env('DRY_RUN', '1') !== '0';

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

async function hostinger(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  await r.body?.cancel(); // corpo descartado: nunca vai para log nem para o painel
  if (!r.ok) throw new Error(`hostinger ${method}: HTTP ${r.status}`);
}

async function report(id, status, erro = '') {
  await painel(`/api/fila/${id}`, { method: 'POST', body: JSON.stringify({ status, erro: String(erro).slice(0, 450) }) });
}

async function main() {
  if (!APP_URL.startsWith('https://') || QUEUE_KEY.length < 32) throw new Error('APP_URL/QUEUE_KEY ausentes');
  const { itens = [] } = await painel('/api/fila');
  console.log(`Fila: ${itens.length} item(ns). DRY_RUN=${DRY_RUN}`);
  for (const { id, slug } of itens) {
    if (!validSlug(slug)) {
      console.log(`#${id} recusado: slug inválido`);
      await report(id, 'erro', 'slug recusado pelo publicador');
      continue;
    }
    const fqdn = `${slug}.${DOMAIN}`;
    if (DRY_RUN) {
      console.log(`#${id} [dry-run] criaria ${fqdn} -> ${DIR_PREFIX}${slug}`);
      continue;
    }
    try {
      await hostinger('POST', ADD_PATH.replace('{domain}', DOMAIN), {
        type: 'subdomain', name: slug, directory: `${DIR_PREFIX}${slug}`,
      });
      if (SSL_PATH) {
        try { await hostinger('POST', SSL_PATH.replace('{domain}', fqdn)); } catch (e) { console.log(`#${id} SSL: ${e.message}`); }
      }
      await report(id, 'feito');
      console.log(`#${id} ok: ${fqdn}`);
    } catch (e) {
      console.log(`#${id} erro: ${e.message}`);
      await report(id, 'erro', e.message);
    }
  }
}

main().catch((e) => { const m = String(e.message); console.error(TOKEN ? m.split(TOKEN).join('***') : m); process.exit(1); });
