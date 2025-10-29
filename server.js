const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

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
const pairingCodes = new Map();

const logger = pino({ level: 'silent' });

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
        version: '3.1.0',
        message: 'API funcionando com QR Code e Pairing Code',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/api/whatsapp/connect', verificarChave, async (req, res) => {
    try {
        const { userId, phoneNumber } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId obrigatorio' });
        }

        console.log('WhatsApp conectando:', userId, phoneNumber ? 'com pairing code' : 'com QR code');

        if (activeSessions.has(userId)) {
            const qrCode = qrCodes.get(userId);
            const pairingCode = pairingCodes.get(userId);
            return res.json({ 
                success: true, 
                message: 'Sessao ja iniciada',
                userId: userId,
                qrCode: qrCode || null,
                pairingCode: pairingCode || null,
                method: pairingCode ? 'pairing' : 'qrcode'
            });
        }

        const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${userId}`);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            logger,
            auth: state,
            printQRInTerminal: false,
            browser: ['Chrome (Linux)', '', ''],
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            markOnlineOnConnect: true,
            syncFullHistory: false,
            getMessage: async (key) => {
                return { conversation: '' };
            }
        });

        sock.ev.on('creds.update', saveCreds);

        let pairingCode = null;
        let qrGenerated = false;

        if (phoneNumber) {
            try {
                await new Promise(resolve => setTimeout(resolve, 2000));
                const cleanPhone = phoneNumber.replace(/\D/g, '');
                console.log('Solicitando pairing code para:', cleanPhone);
                const code = await sock.requestPairingCode(cleanPhone);
                pairingCode = code;
                pairingCodes.set(userId, code);
                console.log('Pairing code gerado:', code);
            } catch (err) {
                console.error('Erro ao gerar pairing code:', err.message);
            }
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !pairingCode) {
                console.log('QR Code gerado');
                try {
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
                } catch (err) {
                    console.error('Erro ao gerar QR Code:', err);
                }
            }

            if (connection === 'close') {
                console.log('Conexao fechada');
                activeSessions.delete(userId);
                qrCodes.delete(userId);
                pairingCodes.delete(userId);

                if (supabase) {
                    await supabase.from('whatsapp_sessions').update({ 
                        status: 'disconnected'
                    }).eq('user_id', userId);
                }
            }

            if (connection === 'open') {
                console.log('WhatsApp conectado com sucesso!');
                qrCodes.delete(userId);
                pairingCodes.delete(userId);

                if (supabase) {
                    await supabase.from('whatsapp_sessions').update({ 
                        status: 'connected',
                        phone_number: sock.user.id.split(':')[0],
                        qr_code: null
                    }).eq('user_id', userId);
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.key.fromMe && msg.message) {
                const messageText = msg.message.conversation || 
                                  msg.message.extendedTextMessage?.text || '';
                console.log('Nova mensagem recebida');

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

        if (pairingCode) {
            return res.json({ 
                success: true, 
                message: 'Digite o codigo no WhatsApp',
                userId: userId,
                pairingCode: pairingCode,
                method: 'pairing'
            });
        }

        let attempts = 0;
        const maxAttempts = 40;
        while (!qrCodes.has(userId) && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }

        const qrCode = qrCodes.get(userId);

        res.json({ 
            success: !!qrCode, 
            message: qrCode ? 'Escaneie o QR Code' : 'Aguarde...',
            userId: userId,
            qrCode: qrCode || null,
            method: 'qrcode'
        });

    } catch (error) {
        console.error('Erro ao conectar WhatsApp:', error);
        res.status(500).json({ 
            error: error.message
        });
    }
});

app.get('/api/whatsapp/qrcode/:userId', verificarChave, async (req, res) => {
    try {
        const { userId } = req.params;
        const qrCode = qrCodes.get(userId);
        const pairingCode = pairingCodes.get(userId);
        
        res.json({ 
            success: !!(qrCode || pairingCode),
            qrCode: qrCode || null,
            pairingCode: pairingCode || null,
            userId: userId,
            method: pairingCode ? 'pairing' : 'qrcode'
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
        const hasPairing = pairingCodes.has(userId);
        
        res.json({
            userId: userId,
            active: isActive,
            hasQRCode: hasQR,
            hasPairingCode: hasPairing,
            status: isActive ? (hasQR || hasPairing ? 'awaiting_connection' : 'connected') : 'disconnected'
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
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log('API pronta - QR Code e Pairing Code disponiveis');
});
