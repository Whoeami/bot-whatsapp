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

// Permite que a Vercel acesse o bot sem bloqueios de segurança (CORS)
app.use(cors({ origin: '*' }));

const clientMP = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(clientMP);

let sock;
let qrCodeImage = null;
let isConnected = false;

async function connectToWhatsApp() {
    // Nome novo para forçar a criação de um QR Code fresco hoje
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_RESET_SABADO');
    
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
            console.log('📱 NOVO QR CODE GERADO! Acesse o link do Render para escanear.');
        }
        if (connection === 'open') {
            isConnected = true;
            qrCodeImage = null;
            console.log('✅ Bot Conectado ao WhatsApp com Sucesso!');
        } else if (connection === 'close') {
            isConnected = false;
            connectToWhatsApp();
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// --- PAINEL E ROTAS ---
app.get('/', (req, res) => {
    if (isConnected) res.send('<h1>Bot Conectado! ✅</h1><a href="/logout">Resetar Conexão</a>');
    else if (qrCodeImage) res.send('<h1>Escaneie o QR Code:</h1><img src="'+qrCodeImage+'" />');
    else res.send('<h1>Bot inicializando... aguarde 15 segundos e atualize.</h1>');
});

// Rota para checar se o servidor está acordado
app.get('/ping', (req, res) => {
    res.send('O bot está ACORDADO e pronto para receber requisições!');
});

app.get('/logout', async (req, res) => {
    if (sock) await sock.logout();
    if (fs.existsSync('./auth_info_RESET_SABADO')) {
        fs.rmSync('./auth_info_RESET_SABADO', { recursive: true, force: true });
    }
    res.send('<h1>Resetado! O bot vai reiniciar.</h1>');
    setTimeout(() => { process.exit(0); }, 1000);
});

// --- ROTA DO PIX ---
app.post('/gerar-cobranca', async (req, res) => {
    console.log("📥 Requisição do site RECEBIDA:", req.body);
    
    const { telefone, nome, valor } = req.body;
    try {
        if (!sock || !isConnected) return res.status(500).json({ erro: 'Bot não conectado' });
        if (!telefone || !nome || !valor) return res.status(400).json({ erro: 'Dados ausentes' });

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
        
        console.log("✅ Mensagem enviada para o WhatsApp:", telefone);
        res.json({ sucesso: true });
    } catch (e) { 
        console.error("❌ ERRO AO GERAR PIX:", e);
        res.status(500).json({ erro: e.message }); 
    }
});

app.post('/webhook-pagamento', async (req, res) => {
    const acao = req.body?.action;
    const pagamentoId = req.body?.data?.id;
    if (acao === 'payment.created' && pagamentoId) {
        try {
            const dados = await payment.get({ id: pagamentoId });
            if (dados.status === 'approved') {
                const { telefone_cliente } = dados.metadata;
                await sock.sendMessage(`${telefone_cliente}@s.whatsapp.net`, { text: 'Pagamento confirmado! 🎉' });
            }
        } catch(e) { console.log(e); }
    }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Servidor Reiniciado na porta ' + PORT));