// api/validar-foto.mjs
// Serverless Function da Vercel (ESM). Sem dependências externas: chama a API REST do Gemini com fetch.
// A chave fica só no servidor, na variável de ambiente GEMINI_API_KEY.

// Modelos tentados em ordem. Se o primeiro estiver sobrecarregado, passa para o próximo.
// Opcional: na Vercel, defina GEMINI_MODELS com nomes separados por vírgula para trocar a lista sem mexer no código.
const MODELOS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash')
  .split(',').map((m) => m.trim()).filter(Boolean);
const TENTATIVAS_POR_MODELO = 2;
const TIMEOUT_POR_TENTATIVA_MS = 6000;
const ORCAMENTO_TOTAL_MS = 24000; // abaixo do maxDuration (30s) do vercel.json

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function chamarGemini(apiKey, body) {
  const inicio = Date.now();
  let ultimo = { ok: false, status: 500, data: { error: { message: 'Nenhum modelo disponível' } } };

  for (const modelo of MODELOS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;

    for (let tentativa = 1; tentativa <= TENTATIVAS_POR_MODELO; tentativa++) {
      if (Date.now() - inicio > ORCAMENTO_TOTAL_MS) return ultimo;

      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_POR_TENTATIVA_MS),
        });
      } catch (e) {
        console.warn(`[${modelo}] tentativa ${tentativa} sem resposta: ${e.name}`);
        ultimo = { ok: false, status: 504, data: { error: { message: 'O Gemini demorou demais para responder' } } };
        continue;
      }

      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        console.log(`Respondeu o modelo: ${modelo}`);
        return { ok: true, data };
      }

      ultimo = { ok: false, status: resp.status, data };
      console.warn(`[${modelo}] tentativa ${tentativa} falhou (${resp.status}): ${data?.error?.message || ''}`);

      // 404 = modelo inexistente/indisponível para a conta: pula direto para o próximo modelo
      if (resp.status === 404) break;
      // Erro definitivo (chave inválida, requisição errada): não adianta insistir
      if (![429, 500, 503].includes(resp.status)) return ultimo;

      await esperar(600 * tentativa);
    }
  }
  return ultimo;
}

// --- Supabase (leitura do desafio do alarme) ---
// A URL e a chave "anon" já são públicas (estão no index.html). Podem ser trocadas por variáveis de ambiente.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://myzcjqcdkdkgnzvjlcuk.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15emNqcWNka2RrZ256dmpsY3VrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM3OTMwNzMsImV4cCI6MjEwOTM2OTA3M30.dw5_j5oymJ71FEfVinUstFJN5KaSbkvmiyZgPe6XhOU';

// Descrição de cada objeto do desafio (as chaves são os mesmos nomes do <select> do cadastro de alarmes).
// Para um objeto novo, basta adicionar uma linha aqui. Sem descrição, usa o próprio nome.
const DESCRICOES = {
  'Escova de Dentes': 'uma escova de dentes (de qualquer cor ou modelo, manual ou elétrica)',
  'Caneca de Café': 'uma caneca, xícara ou copo de café (de qualquer cor ou material)',
  'Espelho do Banheiro': 'o espelho de um banheiro (pode aparecer com pia, bancada ou reflexo)',
  'Tênis de Corrida': 'um tênis esportivo ou de corrida (de qualquer cor ou marca)',
  'Planta / Vaso': 'uma planta ou um vaso de planta (natural, de qualquer tamanho)',
};

// Busca o desafio no banco a partir do id do alarme, sem confiar no que a página enviar.
async function buscarDesafio(alarmId) {
  const url = `${SUPABASE_URL}/rest/v1/alarms?id=eq.${alarmId}&select=challenge`;
  const resp = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`Supabase respondeu ${resp.status}`);
  const linhas = await resp.json();
  return linhas?.[0]?.challenge || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor' });
  }

  try {
    const { image, alarmId } = req.body || {};
    const id = Number(alarmId);
    if (!image || !Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Envie image e alarmId' });
    }

    let challenge;
    try {
      challenge = await buscarDesafio(id);
    } catch (e) {
      console.error('Falha ao buscar desafio:', e);
      return res.status(502).json({ error: 'Não foi possível consultar o desafio no banco: ' + e.message });
    }
    if (!challenge) {
      return res.status(404).json({ error: 'Alarme não encontrado' });
    }
    console.log(`Alarme ${id} - desafio: ${challenge}`);

    // image vem como "data:image/jpeg;base64,AAAA..."
    const match = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(image);
    if (!match) {
      return res.status(400).json({ error: 'Formato de imagem inválido' });
    }
    const mimeType = match[1];
    const base64Data = match[2];

    const objeto = DESCRICOES[challenge] || challenge;
    const prompt =
      `Você valida a foto de um despertador. O usuário precisa fotografar: ${objeto}. ` +
      `Olhe a imagem e responda APROVADO somente se esse objeto real aparece de forma clara e reconhecível. ` +
      `Responda REPROVADO se o objeto não aparece, se está irreconhecível, ou se a imagem é apenas uma foto de uma tela, impressão ou desenho do objeto. ` +
      `Responda APENAS com uma palavra: APROVADO ou REPROVADO.`;

    const resultado = await chamarGemini(apiKey, {
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Data } },
          ],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 512 },
    });

    if (!resultado.ok) {
      console.error('Erro Gemini:', JSON.stringify(resultado.data));
      return res.status(502).json({
        error: resultado.data?.error?.message || 'Erro ao consultar o Gemini',
      });
    }

    const texto = (resultado.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').toUpperCase();
    console.log('Gemini respondeu:', texto);

    const aprovado =
      texto.includes('APROVADO') && !texto.includes('REPROVADO') && !texto.includes('NÃO');

    return res.status(200).json({ resultado: aprovado ? 'APROVADO' : 'REPROVADO' });
  } catch (err) {
    console.error('Erro na função:', err);
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}
