// api/validar-foto.mjs
// Serverless Function da Vercel (ESM). Sem dependências externas: chama a API REST do Gemini com fetch.
// A chave fica só no servidor, na variável de ambiente GEMINI_API_KEY.
// Opcional: defina GEMINI_MODEL na Vercel para trocar o modelo sem mexer no código.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MAX_TENTATIVAS = 3;
const TIMEOUT_POR_TENTATIVA_MS = 7000;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function chamarGemini(apiKey, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  let ultimo = null;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_POR_TENTATIVA_MS),
      });
    } catch (e) {
      // Estourou o tempo da tentativa (ou falha de rede): tenta de novo
      console.warn(`Gemini tentativa ${tentativa}/${MAX_TENTATIVAS} sem resposta: ${e.name}`);
      ultimo = { ok: false, status: 504, data: { error: { message: 'O Gemini demorou demais para responder' } } };
      if (tentativa === MAX_TENTATIVAS) break;
      await esperar(500 * tentativa);
      continue;
    }
    const data = await resp.json().catch(() => ({}));

    if (resp.ok) return { ok: true, data };

    ultimo = { ok: false, status: resp.status, data };

    // 429 (limite) e 503/500 (sobrecarga): vale tentar de novo com espera crescente
    const temporario = [429, 500, 503].includes(resp.status);
    console.warn(`Gemini tentativa ${tentativa}/${MAX_TENTATIVAS} falhou (${resp.status})`);
    if (!temporario || tentativa === MAX_TENTATIVAS) break;

    await esperar(700 * tentativa); // 0,7s, 1,4s, 2,1s
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
