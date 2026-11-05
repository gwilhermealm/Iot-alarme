// api/validar-foto.mjs
// Serverless Function da Vercel (ESM) usando o SDK @google/genai.
// A chave fica só no servidor, na variável de ambiente GEMINI_API_KEY.

import { GoogleGenAI } from '@google/genai';

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

    const ai = new GoogleGenAI({ apiKey });

    const prompt =
      `Você é um validador de um app de despertador. ` +
      `Olhe a imagem e diga se ela mostra claramente o seguinte objeto: "${challenge}". ` +
      `Responda APENAS com uma palavra: APROVADO se o objeto está visível, ou REPROVADO se não está.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: base64Data } },
          ],
        },
      ],
      config: {
        temperature: 0,
        maxOutputTokens: 50,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const texto = (response.text || '').toUpperCase();
    console.log('Gemini respondeu:', texto);

    const aprovado =
      texto.includes('APROVADO') && !texto.includes('REPROVADO') && !texto.includes('NÃO');

    return res.status(200).json({ resultado: aprovado ? 'APROVADO' : 'REPROVADO' });
  } catch (err) {
    console.error('Erro na função:', err);
    return res.status(500).json({ error: 'Erro ao consultar o Gemini: ' + err.message });
  }
}
