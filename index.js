require('dotenv').config();
const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const app = express();

app.use(express.json());

let sock;
let qrCodeImage = null;
let isConnected = false;

async function connectToWhatsApp() {
    // A pasta mudou para 'auth_info_RESET_FINAL' para garantir o reset total
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
            console.log('✅ Conectado!');
        } else if (connection === 'close') {
            isConnected = false;
            connectToWhatsApp();
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// --- PAINEL DE CONTROLE ---
app.get('/', async (req, res) => {
    if (isConnected) {
        res.send('<h1>Bot Conectado! ✅</h1><a href="/logout">Clique aqui para desconectar e resetar</a>');
    } else if (qrCodeImage) {
        res.send('<h1>Escaneie o QR Code abaixo:</h1><img src="' + qrCodeImage + '" />');
    } else {
        res.send('<h1>Bot inicializando... aguarde 30 segundos e atualize a página.</h1>');
    }
});

// --- ROTA DE LOGOUT E RESET ---
app.get('/logout', async (req, res) => {
    if (sock) await sock.logout();
    if (fs.existsSync('./auth_info_RESET_FINAL')) {
        fs.rmSync('./auth_info_RESET_FINAL', { recursive: true, force: true });
    }
    isConnected = false;
    res.send('<h1>Resetado! Aguarde o bot reiniciar sozinho.</h1>');
    setTimeout(() => { process.exit(0); }, 1000);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Rodando na porta ' + PORT));