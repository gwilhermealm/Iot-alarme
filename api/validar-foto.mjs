// api/validar-foto.mjs
// Serverless Function da Vercel (ESM). Chama a API REST do Gemini com fetch.
// Variáveis de ambiente na Vercel: GEMINI_API_KEY e SUPABASE_SERVICE_ROLE_KEY (nunca no front-end).

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

      if (resp.status === 404) break;
      if (![429, 500, 503].includes(resp.status)) return ultimo;

      await esperar(600 * tentativa);
    }
  }
  return ultimo;
}

// --- Supabase ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://myzcjqcdkdkgnzvjlcuk.supabase.co';
// Chave de servidor: ignora o RLS. É a única que consegue marcar o evento como "stopped".
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const headersSupabase = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
});

const DESCRICOES = {
  'Escova de Dentes': 'uma escova de dentes (de qualquer cor ou modelo, manual ou elétrica)',
  'Caneca de Café': 'uma caneca, xícara ou copo de café (de qualquer cor ou material)',
  'Espelho do Banheiro': 'o espelho de um banheiro (pode aparecer com pia, bancada ou reflexo)',
  'Tênis de Corrida': 'um tênis esportivo ou de corrida (de qualquer cor ou marca)',
  'Planta / Vaso': 'uma planta ou um vaso de planta (natural, de qualquer tamanho)',
};

// Busca o evento e o desafio do alarme a que ele pertence (tudo vem do banco, nada da página).
async function buscarEvento(eventId) {
  const url = `${SUPABASE_URL}/rest/v1/alarm_events?id=eq.${eventId}&select=id,status,alarm_id,alarms(challenge)`;
  const resp = await fetch(url, { headers: headersSupabase(), signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`Supabase respondeu ${resp.status}`);
  const linhas = await resp.json();
  return linhas?.[0] || null;
}

// Marca como "stopped" só se ainda estiver "ringing". Retorna true se conseguiu.
async function encerrarEvento(eventId) {
  const url = `${SUPABASE_URL}/rest/v1/alarm_events?id=eq.${eventId}&status=eq.ringing`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { ...headersSupabase(), Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'stopped', stopped_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`Supabase respondeu ${resp.status}`);
  const linhas = await resp.json();
  return linhas.length > 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY não configurada no servidor' });

  try {
    const { image, eventId } = req.body || {};
    const id = Number(eventId);
    if (!image || !Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Envie image e eventId' });
    }

    let evento;
    try {
      evento = await buscarEvento(id);
    } catch (e) {
      console.error('Falha ao buscar evento:', e);
      return res.status(502).json({ error: 'Não foi possível consultar o evento no banco: ' + e.message });
    }
    if (!evento) return res.status(404).json({ error: 'Evento não encontrado' });
    if (evento.status !== 'ringing') return res.status(409).json({ error: 'Este alarme já foi desligado' });

    const challenge = evento.alarms?.challenge;
    if (!challenge) return res.status(404).json({ error: 'Alarme do evento não encontrado' });
    console.log(`Evento ${id} (alarme ${evento.alarm_id}) - desafio: ${challenge}`);

    const match = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(image);
    if (!match) return res.status(400).json({ error: 'Formato de imagem inválido' });
    const mimeType = match[1];
    const base64Data = match[2];

    const objeto = DESCRICOES[challenge] || challenge;
    const prompt =
      `Você valida a foto de um despertador. O usuário precisa fotografar: ${objeto}. ` +
      `Olhe a imagem e responda APROVADO somente se esse objeto real aparece de forma clara e reconhecível. ` +
      `Responda REPROVADO se o objeto não aparece, se está irreconhecível, ou se a imagem é apenas uma foto de uma tela, impressão ou desenho do objeto. ` +
      `Responda APENAS com uma palavra: APROVADO ou REPROVADO.`;

    const resultado = await chamarGemini(apiKey, {
      contents: [{
        role: 'user',
        parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Data } }],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 512 },
    });

    if (!resultado.ok) {
      console.error('Erro Gemini:', JSON.stringify(resultado.data));
      return res.status(502).json({ error: resultado.data?.error?.message || 'Erro ao consultar o Gemini' });
    }

    const texto = (resultado.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').toUpperCase();
    console.log('Gemini respondeu:', texto);

    const aprovado = texto.includes('APROVADO') && !texto.includes('REPROVADO') && !texto.includes('NÃO');

    if (aprovado) {
      let encerrou;
      try {
        encerrou = await encerrarEvento(id);
      } catch (e) {
        console.error('Falha ao encerrar evento:', e);
        return res.status(502).json({ error: 'Foto aprovada, mas não foi possível desligar o alarme: ' + e.message });
      }
      if (!encerrou) return res.status(409).json({ error: 'Este alarme já foi desligado' });
    }

    return res.status(200).json({ resultado: aprovado ? 'APROVADO' : 'REPROVADO' });
  } catch (err) {
    console.error('Erro na função:', err);
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}
