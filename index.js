require('dotenv').config();
const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const app = express();

let sock;
let qrCodeImage = null;
let isConnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
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

// --- PAINEL DE CONTROLE SIMPLES ---
app.get('/', async (req, res) => {
    if (isConnected) {
        res.send(`
            <h1>Bot Conectado! ✅</h1>
            <a href="/logout"><button style="padding:20px; font-size:20px; color:red;">DESCONECTAR BOT</button></a>
        `);
    } else if (qrCodeImage) {
        res.send(`
            <h1>Escaneie o QR Code abaixo:</h1>
            <img src="${qrCodeImage}" />
            <br><br>
            <p>Se não carregar, atualize a página.</p>
        `);
    } else {
        res.send('<h1>Bot inicializando... aguarde 10 segundos e atualize.</h1>');
    }
});

// --- ROTA DE LOGOUT (O BOTÃO DE DESLIGAR) ---
app.get('/logout', async (req, res) => {
    if (sock) await sock.logout();
    if (fs.existsSync('./auth_info')) {
        fs.rmSync('./auth_info', { recursive: true, force: true });
    }
    isConnected = false;
    res.send('<h1>Desconectado! O bot vai reiniciar agora. Aguarde 30 segundos e acesse a página inicial.</h1>');
    setTimeout(() => { process.exit(0); }, 1000);
});

app.listen(3000, () => console.log('🚀 Rodando na porta 3000'));