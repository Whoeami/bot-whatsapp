require('dotenv').config();
const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(express.json());
app.use(cors());

// Config MP
const clientMP = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(clientMP);

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['BotAgendamento', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n📱 Escaneie o QR Code abaixo:');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Robô Conectado!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// ROTA: Gerar Cobrança
app.post('/gerar-cobranca', async (req, res) => {
    const { telefone, nome, valor } = req.body;
    try {
        const idZap = `${telefone}@s.whatsapp.net`; // Formato do Baileys
        
        const cobranca = await payment.create({
            body: {
                transaction_amount: Number(valor.replace(',', '.')),
                description: `Serviço - ${nome}`,
                payment_method_id: 'pix',
                payer: { email: 'cliente@sistema.com' },
                notification_url: 'https://SEU-SITE-NO-RENDER.com/webhook-pagamento', // <- ATUALIZE ESSA URL DEPOIS
                metadata: { telefone_cliente: telefone, nome_cliente: nome }
            }
        });

        const copiaECola = cobranca.point_of_interaction.transaction_data.qr_code;
        
        await sock.sendMessage(idZap, { text: `Olá, *${nome}*! Segue seu Pix: \n\n${copiaECola}` });
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/webhook-pagamento', async (req, res) => {
    // Mesma lógica de webhook, usando sock.sendMessage(telefone + '@s.whatsapp.net', ...)
    res.status(200).send('OK');
});

app.listen(process.env.PORT || 3000);