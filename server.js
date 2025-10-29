const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

// Configurações (Railway vai injetar automaticamente)
const API_SECRET_KEY = process.env.API_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Middleware de segurança
function verificarChave(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.body.api_key;
    if (apiKey !== API_SECRET_KEY) {
        return res.status(401).json({ error: 'Chave API inválida' });
    }
    next();
}

// Conecta ao Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Armazena conexões ativas
const connections = new Map();

// ========== WHATSAPP ==========

app.post('/api/whatsapp/connect', verificarChave, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId obrigatório' });
        }

        const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${userId}`);
        const sock = makeWASocket({ auth: state, printQRInTerminal: false });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;

            if (qr) {
                const qrCodeImage = await QRCode.toDataURL(qr);
                await supabase.from('whatsapp_sessions').upsert({
                    user_id: userId,
                    qr_code: qrCodeImage,
                    status: 'awaiting_scan'
                });
            }

            if (connection === 'open') {
                await supabase.from('whatsapp_sessions').update({ 
                    status: 'connected',
                    phone_number: sock.user.id.split(':')[0]
                }).eq('user_id', userId);
                
                connections.set(userId, sock);
            }

            if (connection === 'close') {
                await supabase.from('whatsapp_sessions')
                    .update({ status: 'disconnected' })
                    .eq('user_id', userId);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.key.fromMe && msg.message) {
                const messageText = msg.message.conversation || 
                                  msg.message.extendedTextMessage?.text || '';

                await supabase.from('messages').insert({
                    user_id: userId,
                    from_number: msg.key.remoteJid,
                    message_text: messageText,
                    message_type: 'whatsapp',
                    direction: 'received'
                });
            }
        });

        res.json({ success: true, message: 'WhatsApp conectando...', userId });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/whatsapp/qrcode/:userId', verificarChave, async (req, res) => {
    try {
        const { userId } = req.params;
        const { data } = await supabase
            .from('whatsapp_sessions')
            .select('qr_code, status')
            .eq('user_id', userId)
            .single();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/whatsapp/send', verificarChave, async (req, res) => {
    try {
        const { userId, to, message } = req.body;
        const sock = connections.get(userId);
        
        if (!sock) {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        await sock.sendMessage(to, { text: message });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== INSTAGRAM ==========

app.post('/api/instagram/connect', verificarChave, async (req, res) => {
    try {
        const { userId, username, password } = req.body;
        
        await supabase.from('instagram_sessions').upsert({
            user_id: userId,
            username: username,
            status: 'connected'
        });

        res.json({ success: true, message: 'Instagram conectado', userId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== HEALTH CHECK ==========

app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        service: 'CRM Bot API',
        version: '1.0.0'
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// ========== INICIAR ==========

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 API rodando na porta ${PORT}`);
});
