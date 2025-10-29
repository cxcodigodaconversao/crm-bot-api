const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

// CORS
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

console.log('🔧 Servidor iniciando...');
console.log('🔑 API_SECRET_KEY:', API_SECRET_KEY ? 'OK' : 'FALTANDO');
console.log('🗄️ SUPABASE_URL:', SUPABASE_URL ? 'OK' : 'FALTANDO');

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('✅ Supabase conectado');
} else {
    console.log('⚠️ Supabase não configurado');
}

const activeSessions = new Map();
const qrCodes = new Map();

// Middleware de autenticação
function verificarChave(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.body.api_key;
    if (apiKey !== API_SECRET_KEY) {
        return res.status(401).json({ 
            error: 'Chave API inválida',
            message: 'Forneça a chave correta no header x-api-key'
        });
    }
    next();
}

// Rota raiz
app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        service: 'CRM Bot API',
        version: '2.0.0',
        message: 'API funcionando com QR Code!',
        endpoints: {
            whatsapp_connect: '/api/whatsapp/connect',
            whatsapp_qrcode: '/api/whatsapp/qrcode/:userId',
            whatsapp_status: '/api/whatsapp/status/:userId',
            instagram_connect: '/api/instagram/connect'
        },
        timestamp: new Date().toISOString()
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Conectar WhatsApp e gerar QR Code
app.post('/api/whatsapp/connect', verificarChave, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ 
                error: 'userId obrigatório',
                message: 'Envie { "userId": "seu-id" } no body'
            });
        }

        console.log('📱 Iniciando conexão WhatsApp para:', userId);

        // Se já existe uma sessão ativa, retorna ela
        if (activeSessions.has(userId)) {
            console.log('♻️ Sessão já existe para:', userId);
            const qrCode = qrCodes.get(userId);
            return res.json({ 
                success: true, 
                message: 'Sessão já iniciada',
                userId: userId,
                status: 'connecting',
                qrCode: qrCode || null
            });
        }

        // Cria nova sessão
        const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${userId}`);
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false
        });

        sock.ev.on('creds.update', saveCreds);

        let qrCodeGenerated = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !qrCodeGenerated) {
                console.log('📱 QR Code gerado para:', userId);
                
                // Converte QR para base64
                const qrCodeImage = await QRCode.toDataURL(qr);
                qrCodes.set(userId, qrCodeImage);
                qrCodeGenerated = true;

                // Salva no Supabase se disponível
                if (supabase) {
                    await supabase
                        .from('whatsapp_sessions')
                        .upsert({
                            user_id: userId,
                            qr_code: qrCodeImage,
                            status: 'awaiting_scan'
                        });
                }
            }

            if (connection === 'close') {
                console.log('❌ Conexão fechada para:', userId);
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                activeSessions.delete(userId);
                qrCodes.delete(userId);

                if (supabase) {
                    await supabase
                        .from('whatsapp_sessions')
                        .update({ status: 'disconnected' })
                        .eq('user_id', userId);
                }

                if (shouldReconnect) {
                    console.log('🔄 Tentando reconectar...');
                }
            }

            if (connection === 'open') {
                console.log('✅ WhatsApp conectado para:', userId);
                qrCodes.delete(userId);

                if (supabase) {
                    await supabase
                        .from('whatsapp_sessions')
                        .update({ 
                            status: 'connected',
                            phone_number: sock.user.id.split(':')[0],
                            qr_code: null
                        })
                        .eq('user_id', userId);
                }
            }
        });

        // Recebe mensagens
        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.key.fromMe && msg.message) {
                const messageText = msg.message.conversation || 
                                  msg.message.extendedTextMessage?.text || '';

                console.log('📩 Nova mensagem de:', msg.key.remoteJid);

                if (supabase) {
                    await supabase
                        .from('messages')
                        .insert({
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

        // Aguarda QR Code ser gerado (máximo 5 segundos)
        let attempts = 0;
        while (!qrCodes.has(userId) && attempts < 25) {
            await new Promise(resolve => setTimeout(resolve, 200));
            attempts++;
