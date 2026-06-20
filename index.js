require('dotenv').config();
const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron'); // 🚀 NOVA BIBLIOTECA DA FASE 2

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: '*' }));

const clientMP = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(clientMP);

const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.trim() : null;
const supabaseKey = process.env.SUPABASE_KEY ? process.env.SUPABASE_KEY.trim() : null;

let supabase = null;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Banco de Dados (Supabase) configurado e pronto para uso!');
} else {
    console.log('⚠️ AVISO: SUPABASE_URL ou SUPABASE_KEY não encontradas.');
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

// =========================================================
// 🚀 FASE 2: O ROBÔ VIGILANTE (Lembrete Antifalta)
// Roda a cada 15 minutos para procurar agendamentos próximos
// =========================================================
cron.schedule('*/15 * * * *', async () => {
    if (!supabase || !isConnected) return; // Só roda se tiver banco de dados e zap conectados

    console.log('⏰ [CRON] Buscando clientes para enviar lembrete de agendamento...');
    
    try {
        const agora = new Date();
        const daqui2Horas = new Date(agora.getTime() + 2 * 60 * 60 * 1000);

        // Força o fuso horário do Brasil para bater exatamente com a sua coluna "time"
        const opcoesFuso = { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };
        const formatadorBrasil = new Intl.DateTimeFormat('sv-SE', opcoesFuso);
        
        // Converte a data para o formato "2026-06-20T14:30:00"
        const agoraLocalStr = formatadorBrasil.format(agora).replace(' ', 'T');
        const daqui2HorasLocalStr = formatadorBrasil.format(daqui2Horas).replace(' ', 'T');

        const { data: agendamentos, error } = await supabase
            .from('appointments')
            .select('*')
            .eq('status', 'aprovado') // O status deve estar aprovado/pago
            .eq('lembrete_enviado', false) // Não pode ter recebido lembrete ainda
            .gte('time', agoraLocalStr) // O horário do corte é maior que agora
            .lte('time', daqui2HorasLocalStr); // O horário do corte é daqui a 2 horas no máximo

        if (error) throw error;

        if (agendamentos && agendamentos.length > 0) {
            console.log(`⏰ [CRON] Encontrei ${agendamentos.length} cliente(s) para avisar!`);

            for (const agendamento of agendamentos) {
                // Pega o telefone (tenta as variações comuns de nome de coluna)
                const telefoneCliente = agendamento.phone || agendamento.telefone || agendamento.whatsapp; 
                
                if (!telefoneCliente) {
                    console.log(`⚠️ ERRO: Agendamento de ${agendamento.client} não tem coluna de telefone preenchida no banco.`);
                    continue;
                }

                // Extrai apenas a hora do corte (ex: 14:30) para ficar bonito no texto
                const horaFormatada = agendamento.time.split('T')[1].substring(0, 5);

                let numeroWhatsApp = telefoneCliente.toString();
                if (!numeroWhatsApp.startsWith('55')) {
                    numeroWhatsApp = '55' + numeroWhatsApp;
                }

                // Radar de Validação do WhatsApp
                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                
                if (result && result.exists) {
                    const mensagemLembrete = `Olá, *${agendamento.client}*! 💈\n\nPassando para lembrar que seu horário conosco está confirmado para hoje às *${horaFormatada}* com o profissional *${agendamento.barber}*.\n\nEstamos te esperando!`;
                    
                    await sock.sendMessage(result.jid, { text: mensagemLembrete });
                    console.log(`✅ Lembrete enviado com sucesso para ${agendamento.client} (${horaFormatada})`);

                    // Atualiza o banco marcando que já enviou
                    await supabase
                        .from('appointments')
                        .update({ lembrete_enviado: true })
                        .eq('id', agendamento.id);
                }
            }
        } else {
            console.log('⏰ [CRON] Nenhum lembrete pendente para as próximas 2 horas.');
        }
    } catch (e) {
        console.error('❌ ERRO NO CRON DE LEMBRETE:', e);
    }
});


// =========================================================
// PAINEL E ROTAS DA API
// =========================================================
app.get('/', (req, res) => {
    if (isConnected) res.send('<h1>Bot Conectado! ✅</h1><a href="/logout">Resetar Conexão</a>');
    else if (qrCodeImage) res.send('<h1>Escaneie o QR Code:</h1><img src="'+qrCodeImage+'" />');
    else res.send('<h1>Bot inicializando... aguarde 15 segundos e atualize.</h1>');
});

app.get('/ping', (req, res) => res.send('O bot está ACORDADO e pronto para receber requisições!'));

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
        if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;

        const [result] = await sock.onWhatsApp(numeroWhatsApp);
        if (!result || !result.exists) return res.status(400).json({ erro: 'Número não possui WhatsApp registrado.' });

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
                if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;
                
                if (supabase) {
                    const { error } = await supabase
                        .from('appointments') 
                        .update({ status: 'aprovado' }) 
                        .eq('client', nomeCliente); 
                    if (error) console.error("❌ Erro ao atualizar o Supabase:", error);
                    else console.log(`✅ MEMÓRIA ATUALIZADA: Pagamento de ${nomeCliente} salvo como aprovado no banco!`);
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