const express = require('express');
const app = express();

app.use(express.json());

// Pega as variáveis
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'crm_2025_super_secret_xyz789';

console.log('✅ Servidor iniciando...');
console.log('🔑 API_SECRET_KEY:', API_SECRET_KEY ? 'Configurada' : 'NÃO configurada');

// Middleware de autenticação
function verificarChave(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.body.api_key;
    if (apiKey !== API_SECRET_KEY) {
        return res.status(401).json({ error: 'Chave API inválida' });
    }
    next();
}

// Rota principal
app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        service: 'CRM Bot API',
        version: '1.0.0',
        message: 'API funcionando perfeitamente!',
        timestamp: new Date().toISOString()
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        uptime: process.uptime()
    });
});

// WhatsApp Connect (versão simples)
app.post('/api/whatsapp/connect', verificarChave, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId obrigatório' });
        }

        console.log('📱 WhatsApp conectando para:', userId);

        res.json({ 
            success: true, 
            message: 'API recebeu a solicitação de conexão WhatsApp',
            userId: userId,
            status: 'pending',
            note: 'Funcionalidade de QR Code será implementada em breve'
        });

    } catch (error) {
        console.error('Erro:', error);
        res.status(500).json({ error: error.message });
    }
});

// Instagram Connect (versão simples)
app.post('/api/instagram/connect', verificarChave, async (req, res) => {
    try {
        const { userId, username } = req.body;
        
        if (!userId || !username) {
            return res.status(400).json({ error: 'userId e username obrigatórios' });
        }

        console.log('📸 Instagram conectando:', username);

        res.json({ 
            success: true, 
            message: 'API recebeu a solicitação de conexão Instagram',
            userId: userId,
            username: username,
            status: 'pending'
        });

    } catch (error) {
        console.error('Erro:', error);
        res.status(500).json({ error: error.message });
    }
});

// Testar autenticação
app.get('/api/test-auth', verificarChave, (req, res) => {
    res.json({ 
        success: true, 
        message: 'Autenticação funcionando!' 
    });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`✅ API está funcionando!`);
});
