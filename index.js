require('dotenv').config();
const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const fs = require('fs'); // Adicionado para poder apagar a pasta

const app = express();
app.use(express.json());
app.use(cors());

const clientMP = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(clientMP);

let sock;

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
            currentQR = qr;
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Robô Conectado!');
            currentQR = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// --- NOVA ROTA: LOGOUT ---
app.get('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout(); // Desconecta do WhatsApp
        }
        // Apaga a pasta de sessão para garantir que não vai reconectar sozinho
        if (fs.existsSync('./auth_info_baileys_4')) {
            fs.rmSync('./auth_info_baileys_4', { recursive: true, force: true });
        }
        res.send('<h1>Desconectado com sucesso! Agora reinicie o serviço no Render para gerar um novo QR Code.</h1>');
    } catch (e) {
        res.send('Erro ao desconectar: ' + e.message);
    }
});

// --- ROTA QR CODE ---
let currentQR = null;
app.get('/qrcode', async (req, res) => {
    if (!currentQR) return res.send('<h1>O bot já está conectado ou aguardando gerar QR...</h1>');
    try {
        const url = await QRCode.toDataURL(currentQR);
        res.send(`<h1>Escaneie este QR Code:</h1><img src="${url}" />`);
    } catch (err) { res.status(500).send('Erro ao gerar imagem.'); }
});

// ... (O restante das rotas de pagamento continua igual)
app.post('/gerar-cobranca', async (req, res) => { /* ... */ });
app.post('/webhook-pagamento', async (req, res) => { /* ... */ });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Motor ativo na porta ${PORT}`));