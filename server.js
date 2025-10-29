const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const API_SECRET_KEY = process.env.API_SECRET_KEY || 'crm_2025_super_secret_xyz789';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

console.log('Servidor iniciando');

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('Supabase conectado');
}

const activeSessions = new Map();
const qrCodes = new Map();

function verificarChave(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.body.api_key;
    if (apiKey !== API_SECRET_KEY) {
        return res.status(401).json({ error: 'Chave API invalida' });
    }
    next();
}

app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        service: 'CRM Bot API',
        version: '2.0.0',
        message: 'API funcionando com QR Code',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/api/whatsapp/connect', verificarChave, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId obrigatorio' });
        }

        console.log('WhatsApp conectando:', userId);

        if (activeSessions.has(userId)) {
            const qrCode = qrCodes.get(userId);
            return res.json({ 
                success: true, 
                message: 'Sessao ja iniciada',
                userId: userId,
                qrCode: qrCode || null
            });
        }

        const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${userId}`);
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false
        });

        sock.ev.on('creds.update', saveCreds);

        let qrGenerated = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !qrGenerated) {
                console.log('QR Code gerado');
                const qrCodeImage = await QRCode.toDataURL(qr);
                qrCodes.set(userId, qrCodeImage);
                qrGenerated = true;

                if (supabase) {
                    await supabase.from('whatsapp_sessions').upsert({
                        user_id: userId,
                        qr_code: qrCodeImage,
                        status: 'awaiting_scan'
                    });
                }
            }

            if (connection === 'close') {
                console.log('Conexao fechada');
                activeSessions.delete(userId);
                qrCodes.delete(userId);

                if (supabase) {
                    await supabase.from('whatsapp_sessions').update({ status: 'disconnected' }).eq('user_id', userId);
                }
            }

            if (connection === 'open') {
                console.log('WhatsApp conectado');
                qrCodes.delete(userId);

                if (supabase) {
                    await supabase.from('whatsapp_sessions').update({ 
                        status: 'connected',
                        phone_number: sock.user.id.split(':')[0]
                    }).eq('user_id', userId);
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.key.fromMe && msg.message) {
                const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                console.log('Nova mensagem:', messageText);

                if (supabase) {
                    await supabase.from('messages').insert({
                        user_id: userId,
                        from_number: msg.key.remoteJid,
                        message_text: messageText,
                        message_type: 'whatsapp',
                        direction: 'received'
                    });
                }
            }
        });

        activeSessions.set(userId, sock);

        let attempts = 0;
        while (!qrCodes.has(userId) && attempts < 25) {
            await new Promise(resolve => setTimeout(resolve, 200));
            attempts++;
        }

        const qrCode = qrCodes.get(userId);

        res.json({ 
            success: true, 
            message: 'Escaneie o QR Code',
            userId: userId,
            qrCode: qrCode || null
        });

    } catch (error) {
        console.error('Erro:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/whatsapp/qrcode/:userId', verificarChave, async (req, res) => {
    try {
        const { userId } = req.params;
        const qrCode = qrCodes.get(userId);
        
        res.json({ 
            success: !!qrCode,
            qrCode: qrCode || null,
            userId: userId
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/whatsapp/status/:userId', verificarChave, async (req, res) => {
    try {
        const { userId } = req.params;
        const isActive = activeSessions.has(userId);
        const hasQR = qrCodes.has(userId);
        
        res.json({
            userId: userId,
            active: isActive,
            hasQRCode: hasQR,
            status: isActive ? (hasQR ? 'awaiting_scan' : 'connected') : 'disconnected'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/instagram/connect', verificarChave, async (req, res) => {
    try {
        const { userId, username } = req.body;
        
        console.log('Instagram conectando:', username);

        if (supabase) {
            await supabase.from('instagram_sessions').upsert({
                user_id: userId,
                username: username,
                status: 'connected'
            });
        }

        res.json({ 
            success: true, 
            message: 'Instagram conectado',
            userId: userId,
            username: username
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('Servidor rodando na porta', PORT);
});
