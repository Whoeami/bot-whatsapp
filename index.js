require('dotenv').config();
const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const clientMP = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(clientMP);

let sock;
let currentQR = null; // Variável para guardar o QR Code atual

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys_4');
    
    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['BarbeariaBot', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQR = qr; // Salva o código para exibir no site
            console.log('\n📱 QR Code gerado! Acesse: https://bot-whatsapp-dibb.onrender.com/qrcode');
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Robô Conectado!');
            currentQR = null; // Limpa o QR Code após conectar
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// ROTA NOVO: Página do QR Code
app.get('/qrcode', async (req, res) => {
    if (!currentQR) return res.send('<h1>O bot já está conectado ou aguardando gerar QR...</h1>');
    
    try {
        const url = await QRCode.toDataURL(currentQR);
        res.send(`<h1>Escaneie este QR Code:</h1><img src="${url}" />`);
    } catch (err) {
        res.status(500).send('Erro ao gerar imagem.');
    }
});

app.post('/gerar-cobranca', async (req, res) => {
    const { telefone, nome, valor } = req.body;
    try {
        if (!sock) return res.status(500).json({ erro: 'Robô não iniciado' });
        
        const valorNumerico = Number(valor.replace(',', '.'));
        const idZap = `${telefone}@s.whatsapp.net`;

        const cobranca = await payment.create({
            body: {
                transaction_amount: valorNumerico,
                description: `Serviço - ${nome}`,
                payment_method_id: 'pix',
                payer: { email: 'cliente@sistema.com' },
                notification_url: 'https://bot-whatsapp-dibb.onrender.com/webhook-pagamento', 
                metadata: { telefone_cliente: telefone, nome_cliente: nome }
            }
        });

        const copiaECola = cobranca.point_of_interaction.transaction_data.qr_code;
        await sock.sendMessage(idZap, { text: `Olá, *${nome}*! 👋\n\nSeu horário foi reservado. Valor: *R$ ${valor}*.\n\nCopie o código Pix abaixo:` });
        await sock.sendMessage(idZap, { text: copiaECola });

        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/webhook-pagamento', async (req, res) => {
    const acao = req.body?.action;
    const pagamentoId = req.body?.data?.id;

    if (acao === 'payment.created' && pagamentoId) {
        try {
            const dadosPagamento = await payment.get({ id: pagamentoId });
            if (dadosPagamento.status === 'approved') {
                const { telefone_cliente, nome_cliente } = dadosPagamento.metadata;
                await sock.sendMessage(`${telefone_cliente}@s.whatsapp.net`, { 
                    text: `Oba, *${nome_cliente}*! 🎉\n\nPagamento confirmado! Até lá! ✂️` 
                });
            }
        } catch (e) { console.error(e); }
    }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Motor ativo na porta ${PORT}`));