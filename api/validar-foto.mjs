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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor' });
  }

  try {
    const { image, challenge } = req.body || {};
    if (!image || !challenge) {
      return res.status(400).json({ error: 'Envie image e challenge' });
    }

    // image vem como "data:image/jpeg;base64,AAAA..."
    const match = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(image);
    if (!match) {
      return res.status(400).json({ error: 'Formato de imagem inválido' });
    }
    const mimeType = match[1];
    const base64Data = match[2];

    const prompt =
      `Você é um validador de um app de despertador. ` +
      `Olhe a imagem e diga se ela mostra claramente o seguinte objeto: "${challenge}". ` +
      `Responda APENAS com uma palavra: APROVADO se o objeto está visível, ou REPROVADO se não está.`;

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
