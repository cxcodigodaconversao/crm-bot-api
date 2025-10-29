app.post('/api/whatsapp/connect', verificarChave, async (req, res) => {
    try {
        const { userId, phoneNumber } = req.body;
        
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

        // Se tiver número de telefone, gera pairing code
        if (phoneNumber) {
            try {
                const cleanPhone = phoneNumber.replace(/\D/g, '');
                const code = await sock.requestPairingCode(cleanPhone);
                pairingCode = code;
                console.log('Pairing code gerado:', code);
            } catch (err) {
                console.error('Erro ao gerar pairing code:', err);
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

                if (supabase) {
                    await supabase.from('whatsapp_sessions').update({ 
                        status: 'disconnected'
                    }).eq('user_id', userId);
                }
            }

            if (connection === 'open') {
                console.log('WhatsApp conectado com sucesso!');
                qrCodes.delete(userId);

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

        // Se gerou pairing code, retorna imediatamente
        if (pairingCode) {
            return res.json({ 
                success: true, 
                message: 'Digite o codigo no WhatsApp',
                userId: userId,
                pairingCode: pairingCode,
                method: 'pairing'
            });
        }

        // Senão, aguarda QR Code
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
```

**5.** Clique em **"Commit changes"**

---

### **PASSO 2: Atualizar o Frontend no Lovable**

**1.** No Lovable, no chat **"Ask Lovable..."**, cole:
```
Adicione suporte para Pairing Code do WhatsApp:

1. Adicione um campo de input para o usuário digitar o número de telefone (com código do país, ex: 5511999999999)

2. Ao clicar em "Gerar QR Code", se o número estiver preenchido:
   - Enviar no POST: { userId, phoneNumber }
   - A API vai retornar: { success: true, pairingCode: "12345678", method: "pairing" }
   - Mostrar o código grande na tela: "Digite este código no WhatsApp: 1234-5678"
   - Instruções: "1. Abra WhatsApp > Aparelhos conectados > Conectar aparelho > Vincular com número"

3. Se não tiver número, funciona normal com QR Code

4. Adicione botão para alternar entre os dois métodos
