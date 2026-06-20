require('dotenv').config();
const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Mercado Pago
const clientMP = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(clientMP);

let sock;
let qrCodeImage = null;
let isConnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_RESET_FINAL');
    
    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['BarbeariaBot', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        if (qr) {
            isConnected = false;
            qrCodeImage = await QRCode.toDataURL(qr);
        }
        if (connection === 'open') {
            isConnected = true;
            qrCodeImage = null;
            console.log('✅ Bot Conectado!');
        } else if (connection === 'close') {
            isConnected = false;
            connectToWhatsApp();
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// --- PAINEL DE CONTROLE (Link Principal) ---
app.get('/', (req, res) => {
    if (isConnected) res.send('<h1>Bot Conectado! ✅</h1><a href="/logout">Resetar Conexão</a>');
    else if (qrCodeImage) res.send('<h1>Escaneie o QR Code:</h1><img src="'+qrCodeImage+'" />');
    else res.send('<h1>Bot inicializando... aguarde.</h1>');
});

// --- ROTA DE LOGOUT E RESET ---
app.get('/logout', async (req, res) => {
    if (sock) await sock.logout();
    if (fs.existsSync('./auth_info_RESET_FINAL')) {
        fs.rmSync('./auth_info_RESET_FINAL', { recursive: true, force: true });
    }
    res.send('<h1>Resetado! O bot vai reiniciar.</h1>');
    setTimeout(() => { process.exit(0); }, 1000);
});

// --- ROTAS DE PAGAMENTO (O que estava faltando) ---
app.post('/gerar-cobranca', async (req, res) => {
    const { telefone, nome, valor } = req.body;
    try {
        if (!sock) return res.status(500).json({ erro: 'Bot não iniciado' });
        
        const cobranca = await payment.create({
            body: {
                transaction_amount: Number(valor.replace(',', '.')),
                description: `Serviço - ${nome}`,
                payment_method_id: 'pix',
                notification_url: 'https://bot-whatsapp-dibb.onrender.com/webhook-pagamento',
                metadata: { telefone_cliente: telefone, nome_cliente: nome }
            }
        });

        const copiaECola = cobranca.point_of_interaction.transaction_data.qr_code;
        await sock.sendMessage(`${telefone}@s.whatsapp.net`, { text: `Olá *${nome}*! Segue o Pix:\n\n${copiaECola}` });
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/webhook-pagamento', async (req, res) => {
    const acao = req.body?.action;
    const pagamentoId = req.body?.data?.id;
    if (acao === 'payment.created' && pagamentoId) {
        const dados = await payment.get({ id: pagamentoId });
        if (dados.status === 'approved') {
            const { telefone_cliente } = dados.metadata;
            await sock.sendMessage(`${telefone_cliente}@s.whatsapp.net`, { text: 'Pagamento confirmado! 🎉' });
        }
    }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Rodando na porta ' + PORT));