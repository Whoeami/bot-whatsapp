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

app.use(cors({ origin: '*' }));

const clientMP = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(clientMP);

let sock;
let qrCodeImage = null;
let isConnected = false;

async function connectToWhatsApp() {
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

app.get('/', (req, res) => {
    if (isConnected) res.send('<h1>Bot Conectado! ✅</h1><a href="/logout">Resetar Conexão</a>');
    else if (qrCodeImage) res.send('<h1>Escaneie o QR Code:</h1><img src="'+qrCodeImage+'" />');
    else res.send('<h1>Bot inicializando... aguarde 15 segundos e atualize.</h1>');
});

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
                payer: { email: 'cliente@barbearia.com' },
                notification_url: 'https://bot-whatsapp-dibb.onrender.com/webhook-pagamento',
                metadata: { telefone_cliente: telefone, nome_cliente: nome }
            }
        });

        const copiaECola = cobranca.point_of_interaction.transaction_data.qr_code;
        
        // Garante o 55 do Brasil
        let numeroWhatsApp = telefone.toString();
        if (!numeroWhatsApp.startsWith('55')) {
            numeroWhatsApp = '55' + numeroWhatsApp;
        }

        // 🚀 O RADAR: Pergunta ao WhatsApp se o número existe e qual é o ID correto dele
        const [result] = await sock.onWhatsApp(numeroWhatsApp);
        
        if (!result || !result.exists) {
            console.log("❌ ERRO: O WhatsApp disse que esse número não existe lá:", numeroWhatsApp);
            return res.status(400).json({ erro: 'Número não possui WhatsApp registrado.' });
        }

        // Usa o número exato que o WhatsApp devolveu (com ou sem o 9)
        const jidCorreto = result.jid;

        await sock.sendMessage(jidCorreto, { text: `Olá *${nome}*! Segue o Pix:\n\n${copiaECola}` });
        
        console.log("✅ Mensagem enviada com sucesso para o JID correto:", jidCorreto);
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
                let numeroWhatsApp = dados.metadata.telefone_cliente.toString();
                if (!numeroWhatsApp.startsWith('55')) {
                    numeroWhatsApp = '55' + numeroWhatsApp;
                }
                
                // Radar também no webhook
                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                if (result && result.exists) {
                    await sock.sendMessage(result.jid, { text: 'Pagamento confirmado! 🎉 Seu agendamento está garantido.' });
                }
            }
        } catch(e) { console.log(e); }
    }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Servidor Reiniciado na porta ' + PORT));