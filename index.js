require('dotenv').config();
const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

const clientMP = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(clientMP);

let sock;
let currentQR = null;

async function connectToWhatsApp() {
    // Usaremos uma pasta fixa, mas vamos deletá-la se precisar
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
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

// --- O BOTÃO NUCLEAR DE RESET ---
app.get('/logout', async (req, res) => {
    try {
        console.log('⚠️ Solicitado logout e reset total...');
        if (sock) {
            try { await sock.logout(); } catch(e) {}
        }
        
        // Apaga a pasta de sessão
        if (fs.existsSync('./auth_info_baileys')) {
            fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
        }
        
        res.send('<h1>Sistema Resetado. O bot vai reiniciar agora...</h1>');
        
        // FORÇA O REINÍCIO DO RENDER
        setTimeout(() => { process.exit(0); }, 1000);
        
    } catch (e) {
        res.send('Erro no reset: ' + e.message);
    }
});

// --- ROTA QR CODE ---
app.get('/qrcode', async (req, res) => {
    if (!currentQR) return res.send('<h1>O bot já está conectado ou aguardando gerar QR. Se você acabou de resetar, espere 10 segundos e atualize a página.</h1>');
    try {
        const url = await QRCode.toDataURL(currentQR);
        res.send(`<h1>Escaneie este QR Code:</h1><img src="${url}" />`);
    } catch (err) { res.status(500).send('Erro ao gerar imagem.'); }
});

// ... (Rotas de pagamento permanecem iguais)
app.post('/gerar-cobranca', async (req, res) => { /* ... */ });
app.post('/webhook-pagamento', async (req, res) => { /* ... */ });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Motor ativo na porta ${PORT}`));