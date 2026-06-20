require('dotenv').config();
const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: '*' }));

// Configuração Mercado Pago
const clientMP = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(clientMP);

// 🚀 BLINDAGEM DO SUPABASE: Só conecta se as chaves existirem de verdade
const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.trim() : null;
const supabaseKey = process.env.SUPABASE_KEY ? process.env.SUPABASE_KEY.trim() : null;

let supabase = null;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Banco de Dados (Supabase) configurado e pronto para uso!');
} else {
    console.log('⚠️ AVISO: SUPABASE_URL ou SUPABASE_KEY não encontradas. O bot de Pix vai funcionar, mas não vai salvar a memória no banco.');
}

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
        
        let numeroWhatsApp = telefone.toString();
        if (!numeroWhatsApp.startsWith('55')) {
            numeroWhatsApp = '55' + numeroWhatsApp;
        }

        const [result] = await sock.onWhatsApp(numeroWhatsApp);
        
        if (!result || !result.exists) {
            console.log("❌ ERRO: O WhatsApp disse que esse número não existe lá:", numeroWhatsApp);
            return res.status(400).json({ erro: 'Número não possui WhatsApp registrado.' });
        }

        const jidCorreto = result.jid;

        const mensagemTexto = `Olá, *${nome}*! 👋\n\nSeu horário foi reservado com sucesso. O valor do serviço é de *R$ ${valor}*.\n\nPara confirmar, copie o código Pix na mensagem abaixo e cole no aplicativo do seu banco.\n\n_Após o pagamento, o nosso sistema confirmará automaticamente._`;
        
        await sock.sendMessage(jidCorreto, { text: mensagemTexto });
        await sock.sendMessage(jidCorreto, { text: copiaECola });
        
        console.log("✅ Mensagens enviadas com sucesso com a nova formatação!");
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
                const nomeCliente = dados.metadata.nome_cliente;
                let numeroWhatsApp = dados.metadata.telefone_cliente.toString();
                
                if (!numeroWhatsApp.startsWith('55')) {
                    numeroWhatsApp = '55' + numeroWhatsApp;
                }
                
                // Só tenta atualizar o banco se as credenciais do Supabase estiverem ok
                if (supabase) {
                    const { error } = await supabase
                        .from('appointments') 
                        .update({ status: 'aprovado' }) 
                        .eq('client', nomeCliente); 

                    if (error) {
                        console.error("❌ Erro ao atualizar o Supabase:", error);
                    } else {
                        console.log(`✅ MEMÓRIA ATUALIZADA: Pagamento de ${nomeCliente} salvo como aprovado no banco!`);
                    }
                }

                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                if (result && result.exists) {
                    await sock.sendMessage(result.jid, { text: 'Pagamento confirmado! 🎉 Seu agendamento está garantido e atualizado em nosso sistema.' });
                }
            }
        } catch(e) { console.log(e); }
    }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Servidor Reiniciado na porta ' + PORT));