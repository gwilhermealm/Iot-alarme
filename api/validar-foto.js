// api/validar-foto.js
import { GoogleGenAI } from '@google/genai';

export default async function handler(req, res) {
  // Garante que apenas requisições POST sejam aceitas
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const { image, challenge } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'Nenhuma imagem foi enviada.' });
    }

    // Inicializa a IA com a chave segura configurada na Vercel
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // Trata o base64 da imagem recebida do front-end
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const objetoDesejado = challenge || "Espelho";
    const promptText = `Analise esta foto com rigor. O usuário precisa apresentar o seguinte objeto: "${objetoDesejado}". A imagem realmente mostra este objeto de forma clara? Responda APENAS com a palavra "SIM" ou "NAO".`;

    // Chamada oficial utilizando o modelo correto gemini-2.0-flash
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [
        {
          inlineData: {
            data: buffer.toString('base64'),
            mimeType: 'image/jpeg',
          },
        },
        promptText,
      ],
    });

    const textoResposta = response.text ? response.text.trim() : "";

    return res.status(200).json({ 
      success: true, 
      resultado: textoResposta 
    });

  } catch (error) {
    console.error('Erro interno na API de validação:', error);
    return res.status(500).json({ error: error.message || 'Erro ao processar a validação.' });
  }
}