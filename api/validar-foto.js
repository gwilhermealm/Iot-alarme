// api/validar-foto.js
import { GoogleGenAI } from '@google/genai';

export default async function handler(req, res) {
  // Garante que é uma requisição POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const { image, challenge } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    }

    // Inicializa o cliente do Gemini de forma segura no servidor
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // Trata o Base64 da imagem
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const objetoDesejado = challenge || "Espelho do Banheiro";
    const promptText = `Analise esta foto com rigor. O usuário precisa apresentar o seguinte objeto para desligar o alarme: "${objetoDesejado}". A imagem realmente mostra este objeto de forma clara? Responda estritamente no formato JSON: {"status": "APROVADO" ou "REPROVADO", "motivo": "explicação breve"}`;

    // Chamada correta utilizando o modelo gemini-2.5-flash
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
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

    return res.status(200).json({ 
      success: true, 
      resultado: response.text 
    });

  } catch (error) {
    console.error('Erro ao validar imagem:', error);
    return res.status(500).json({ error: 'Erro interno ao processar a imagem com a IA.' });
  }
}