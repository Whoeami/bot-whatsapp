require('dotenv').config();
const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================================================
// 🛡️ CONFIGURAÇÃO DE SEGURANÇA AVANÇADA (CORS E ANTI-SPAM)
// =========================================================

// 1. Defina aqui quais sites podem acessar o seu servidor
const URLsPermitidas = [
    'http://localhost:5173', // Permite que você teste no seu computador local (Vite)
    'https://bot-whatsapp-dibb.onrender.com', // O próprio servidor do Render
    'https://barbearia-sua-zeta.vercel.app' // 🚀 SEU LINK DA VERCEL
];

app.use(cors({
    origin: function (origin, callback) {
        // Permite requisições sem origem (como o próprio servidor fazendo testes internos)
        if (!origin) return callback(null, true);
        
        // Verifica se o site que está chamando começa com alguma das URLs permitidas
        const permitido = URLsPermitidas.some(url => origin.startsWith(url));
        if (permitido) {
            return callback(null, true);
        } else {
            console.log(`🚨 BLOQUEIO CORS: Site não autorizado tentou acessar a API: ${origin}`);
            return callback(new Error('Acesso bloqueado por segurança (CORS)'), false);
        }
    }
}));

// 2. Sistema nativo de proteção contra ataques de repetição (Spam)
const memoriaDeTentativas = new Map();

function protetorAntiSpam(req, res, next) {
    // Pega o IP de quem está fazendo a requisição
    const ipDoUsuario = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const agora = Date.now();
    const TEMPO_DE_BLOQUEIO = 10 * 60 * 1000; // 10 minutos de castigo
    const LIMITE_MAXIMO = 5; // Máximo de 5 agendamentos gerados seguidos

    if (!memoriaDeTentativas.has(ipDoUsuario)) {
        memoriaDeTentativas.set(ipDoUsuario, { tentativas: 1, primeiroAcesso: agora });
        return next();
    }

    const historico = memoriaDeTentativas.get(ipDoUsuario);

    // Se o cliente já esperou os 10 minutos, o contador zera para ele
    if (agora - historico.primeiroAcesso > TEMPO_DE_BLOQUEIO) {
        memoriaDeTentativas.set(ipDoUsuario, { tentativas: 1, primeiroAcesso: agora });
        return next();
    }

    historico.tentativas += 1;

    // Se estourar o limite de 5 cliques em menos de 10 minutos, bloqueia o acesso à rota
    if (historico.tentativas > LIMITE_MAXIMO) {
        console.log(`🚨 ANTI-SPAM: IP ${ipDoUsuario} bloqueado por excesso de requisições.`);
        return res.status(429).json({ 
            erro: 'Muitas tentativas seguidas. Seu IP foi bloqueado temporariamente por 10 minutos para proteção do servidor.' 
        });
    }

    next();
}

// =========================================================
// INICIALIZAÇÃO DE SERVIÇOS (MP e Supabase)
// =========================================================

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
// 🚀 FASE 2: O ROBÔ VIGILANTE (Lembrete Antifalta - 2h)
// =========================================================
cron.schedule('*/15 * * * *', async () => {
    if (!supabase || !isConnected) return;

    console.log('⏰ [CRON] Buscando clientes para enviar lembrete de 2 horas...');
    
    try {
        const agora = new Date();
        const daqui2Horas = new Date(agora.getTime() + 2 * 60 * 60 * 1000);

        const opcoesFuso = { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };
        const formatadorBrasil = new Intl.DateTimeFormat('sv-SE', opcoesFuso);
        
        const agoraLocalStr = formatadorBrasil.format(agora).replace(' ', 'T');
        const daqui2HorasLocalStr = formatadorBrasil.format(daqui2Horas).replace(' ', 'T');

        const { data: agendamentos, error } = await supabase
            .from('appointments')
            .select('*')
            .in('status', ['aprovado', 'Confirmado', 'confirmado']) 
            .eq('lembrete_enviado', false)
            .gte('time', agoraLocalStr)
            .lte('time', daqui2HorasLocalStr);

        if (error) throw error;

        if (agendamentos && agendamentos.length > 0) {
            console.log(`⏰ [CRON] Encontrei ${agendamentos.length} cliente(s) para avisar (2h)!`);

            for (const agendamento of agendamentos) {
                const telefoneCliente = agendamento.phone || agendamento.telefone || agendamento.whatsapp; 
                
                if (!telefoneCliente) {
                    console.log(`⚠️ ERRO: Agendamento de ${agendamento.client} não tem telefone preenchido no banco.`);
                    continue;
                }

                const horaFormatada = agendamento.time.split('T')[1].substring(0, 5);

                let numeroWhatsApp = telefoneCliente.toString();
                if (!numeroWhatsApp.startsWith('55')) {
                    numeroWhatsApp = '55' + numeroWhatsApp;
                }

                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                
                if (result && result.exists) {
                    const mensagemLembrete = `Olá, *${agendamento.client}*! 💈\n\nPassando para lembrar que seu horário conosco está confirmado para hoje às *${horaFormatada}* com o profissional *${agendamento.barber}*.\n\nEstamos te esperando!`;
                    
                    await sock.sendMessage(result.jid, { text: mensagemLembrete });
                    console.log(`✅ Lembrete de 2h enviado com sucesso para ${agendamento.client} (${horaFormatada})`);

                    await supabase
                        .from('appointments')
                        .update({ lembrete_enviado: true })
                        .eq('id', agendamento.id);
                }
            }
        } else {
            console.log('⏰ [CRON] Nenhum lembrete de 2 horas pendente.');
        }
    } catch (e) {
        console.error('❌ ERRO NO CRON DE LEMBRETE 2H:', e);
    }
});

// =========================================================
// 🚀 FASE 3: ROBÔ DE FEEDBACK (Roda todo dia às 09:00)
// =========================================================
cron.schedule('0 9 * * *', async () => {
    if (!supabase || !isConnected) return;

    console.log('⭐ [CRON] Buscando clientes para pedir feedback...');
    
    try {
        const ontem = new Date();
        ontem.setDate(ontem.getDate() - 1); // Pega o dia de ontem
        const dataOntem = ontem.toISOString().split('T')[0];

        const { data: agendamentos, error } = await supabase
            .from('appointments')
            .select('*')
            .eq('status', 'Concluído')
            .eq('feedback_enviado', false)
            .gte('time', `${dataOntem}T00:00:00`)
            .lte('time', `${dataOntem}T23:59:59`);

        if (error) throw error;

        if (agendamentos && agendamentos.length > 0) {
            for (const agendamento of agendamentos) {
                const telefoneCliente = agendamento.phone || agendamento.telefone || agendamento.whatsapp;
                if (!telefoneCliente) continue;

                // ⚠️ TROQUE AQUI PELO SEU LINK REAL
                const linkAvaliacao = "https://g.page/r/CY060O6MsL4dEAE/review"; 

                const mensagem = `Olá, *${agendamento.client}*! 👋\n\nPassando para saber o que achou do atendimento aqui na barbearia ontem.\n\nSua opinião nos ajuda a sempre melhorar! Poderia deixar uma avaliação rápida pra gente aqui? 👇\n\n${linkAvaliacao}\n\nObrigado!`;
                
                let numeroWhatsApp = telefoneCliente.toString();
                if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;

                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                if (result && result.exists) {
                    await sock.sendMessage(result.jid, { text: mensagem });
                    console.log(`⭐ Feedback enviado para ${agendamento.client}`);

                    await supabase
                        .from('appointments')
                        .update({ feedback_enviado: true })
                        .eq('id', agendamento.id);
                }
            }
        }
    } catch (e) {
        console.error('❌ ERRO NO CRON DE FEEDBACK:', e);
    }
});

// =========================================================
// 🚀 FASE 4: ROBÔ DO PIX ESQUECIDO (Roda a cada 1 hora)
// =========================================================
cron.schedule('0 * * * *', async () => {
    if (!supabase || !isConnected) return;

    console.log('💰 [CRON] Buscando Pix pendentes para recuperar...');
    
    try {
        const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        const { data: agendamentos, error } = await supabase
            .from('appointments')
            .select('*')
            .eq('status', 'Pendente')
            .lt('created_at', umaHoraAtras);

        if (error) throw error;

        if (agendamentos && agendamentos.length > 0) {
            for (const agendamento of agendamentos) {
                const telefoneCliente = agendamento.phone || agendamento.telefone || agendamento.whatsapp;
                if (!telefoneCliente) continue;

                const mensagem = `Olá, *${agendamento.client}*! 👋\n\nNotei que você gerou um agendamento com a gente, mas o Pix ainda não foi confirmado.\n\nO seu horário só é garantido após a confirmação do pagamento. Quer que eu te envie o código Pix novamente? 😉`;
                
                let numeroWhatsApp = telefoneCliente.toString();
                if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;

                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                if (result && result.exists) {
                    await sock.sendMessage(result.jid, { text: mensagem });
                    console.log(`💰 Pix esquecido lembrado para ${agendamento.client}`);
                }
            }
        }
    } catch (e) {
        console.error('❌ ERRO NO CRON DO PIX:', e);
    }
});

// =========================================================
// 🚀 FASE 5: LEMBRETE UM DIA ANTES (24 Horas Antes)
// =========================================================
cron.schedule('*/15 * * * *', async () => {
    if (!supabase || !isConnected) return;

    console.log('📅 [CRON] Buscando clientes para enviar lembrete de 24 horas antes...');
    
    try {
        const agora = new Date();
        const daqui24Horas = new Date(agora.getTime() + 24 * 60 * 60 * 1000);
        const daqui24HorasFim = new Date(daqui24Horas.getTime() + 15 * 60 * 1000);

        const opcoesFuso = { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };
        const formatadorBrasil = new Intl.DateTimeFormat('sv-SE', opcoesFuso);
        
        const daqui24HorasStr = formatadorBrasil.format(daqui24Horas).replace(' ', 'T');
        const daqui24HorasFimStr = formatadorBrasil.format(daqui24HorasFim).replace(' ', 'T');

        const { data: agendamentos, error } = await supabase
            .from('appointments')
            .select('*')
            .in('status', ['aprovado', 'Confirmado', 'confirmado']) 
            .eq('lembrete_24h_enviado', false) 
            .gte('time', daqui24HorasStr)
            .lte('time', daqui24HorasFimStr);

        if (error) throw error;

        if (agendamentos && agendamentos.length > 0) {
            console.log(`📅 [CRON] Encontrei ${agendamentos.length} cliente(s) para o lembrete de amanhã!`);

            for (const agendamento of agendamentos) {
                const telefoneCliente = agendamento.phone || agendamento.telefone || agendamento.whatsapp; 
                if (!telefoneCliente) continue;

                const horaFormatada = agendamento.time.split('T')[1].substring(0, 5);
                const dataCorte = agendamento.time.split('T')[0];
                const [ano, mes, dia] = dataCorte.split('-');

                let numeroWhatsApp = telefoneCliente.toString();
                if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;

                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                
                if (result && result.exists) {
                    const mensagemLembrete = `Olá, *${agendamento.client}*! 👋\n\nPassando para lembrar que você tem um horário agendado para amanhã, dia *${dia}/${mes}* às *${horaFormatada}* com o profissional *${agendamento.barber}*.\n\n📍 *Localização:* Rua Exemplo, nº 123 - Bairro Centro\n\nEstamos preparando tudo para te receber! Se tiver algum imprevisto, avise a gente. ✂️`;
                    
                    await sock.sendMessage(result.jid, { text: mensagemLembrete });
                    console.log(`✅ Lembrete de 24h enviado para ${agendamento.client} (${horaFormatada})`);

                    await supabase
                        .from('appointments')
                        .update({ lembrete_24h_enviado: true })
                        .eq('id', agendamento.id);
                }
            }
        } else {
            console.log('📅 [CRON] Nenhum lembrete de 24 horas pendente.');
        }
    } catch (e) {
        console.error('❌ ERRO NO CRON DE LEMBRETE 24H:', e);
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

// 👇 ROTA BLINDADA COM O PROTETOR ANTI-SPAM 👇
app.post('/gerar-cobranca', protetorAntiSpam, async (req, res) => {
    console.log("📥 Requisição do site RECEBIDA:", req.body);
    
    const { telefone, nome, valor } = req.body;
    try {
        if (!sock || !isConnected) return res.status(500).json({ erro: 'Bot não conectado' });
        if (!telefone || !nome || !valor) return res.status(400).json({ erro: 'Dados ausentes' });

        const amanha = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const dataExpiracaoFormatada = amanha.toISOString().split('.')[0] + '.000-03:00';

        const cobranca = await payment.create({
            body: {
                transaction_amount: Number(valor.replace(',', '.')),
                description: `Serviço - ${nome}`,
                payment_method_id: 'pix',
                date_of_expiration: dataExpiracaoFormatada, 
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

// 🔥 ROTA DEFINITIVA: MUDANÇA DE STATUS + ANTI-DUPLICAÇÃO 🔥
app.post('/webhook-pagamento', async (req, res) => {
    console.log("🔔 [WEBHOOK] O Mercado Pago bateu na porta!", JSON.stringify(req.body));
    
    // Captura o ID de todas as formas possíveis
    let pagamentoId = req.body?.data?.id || req.body?.id;
    if (!pagamentoId && req.body?.resource) {
        pagamentoId = req.body.resource.replace(/\D/g, ''); 
    }
    
    if (pagamentoId) {
        try {
            console.log(`🔍 [WEBHOOK] Buscando detalhes do pagamento ID: ${pagamentoId}...`);
            const dados = await payment.get({ id: pagamentoId });
            
            console.log(`💵 [WEBHOOK] Status real do pagamento: ${dados.status}`);
            
            if (dados.status === 'approved') {
                console.log("✅ [WEBHOOK] Pagamento aprovado! Lendo metadata:", dados.metadata);
                
                let numeroWhatsApp = dados.metadata?.telefone_cliente?.toString();
                
                if (numeroWhatsApp) {
                    if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;
                    
                    let linhaFoiAtualizada = false; // 🔒 NOSSA TRAVA DE SEGURANÇA

                    if (supabase) {
                        const numeroLimpo = numeroWhatsApp.replace(/\D/g, '');
                        console.log(`🗄️ [SUPABASE] Buscando agendamento Pendente para o telefone: ${numeroLimpo.slice(-8)}`);

                        const { data, error } = await supabase
                            .from('appointments') 
                            .update({ 
                                status: 'Confirmado',
                                payment_method: 'Pix'
                            }) 
                            // ✂️ Removemos a busca por nome para evitar falhas de digitação
                            .like('phone', `%${numeroLimpo.slice(-8)}%`) 
                            .ilike('status', 'pendente')
                            .select(); 

                        if (error) {
                            console.error("❌ [SUPABASE] Erro ao atualizar o banco:", error);
                        } else if (data && data.length > 0) {
                            console.log(`✅ [SUPABASE] SUCESSO! Linha atualizada no banco:`, data);
                            linhaFoiAtualizada = true; // 🟢 Liberou o envio do WhatsApp!
                        } else {
                            console.log(`⚠️ [SUPABASE] Nenhuma linha alterada. (Ou o número não existe, ou este webhook é duplicado e já foi processado).`);
                        }
                    }

                    // 📱 SÓ ENVIA O WHATSAPP SE O BANCO FOI ATUALIZADO NESTA REQUISIÇÃO
                    if (linhaFoiAtualizada) {
                        const [result] = await sock.onWhatsApp(numeroWhatsApp);
                        if (result && result.exists) {
                            await sock.sendMessage(result.jid, { text: 'Pagamento confirmado! 🎉 Seu agendamento está garantido e atualizado em nosso sistema.' });
                            console.log(`📱 [WHATSAPP] Mensagem ÚNICA enviada para ${numeroWhatsApp}`);
                        }
                    }
                }
            }
        } catch(e) { 
            console.error("❌ [WEBHOOK] ERRO CRÍTICO no processamento:", e); 
        }
    }
    
    res.status(200).send('OK');
});

// =========================================================
// 🛡️ SISTEMA ANTI-QUEDA (Evita que o bot feche sozinho)
// =========================================================
process.on('uncaughtException', function (err) {
    console.error('❌ Erro não tratado (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Rejeição não tratada (unhandledRejection):', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Servidor Reiniciado na porta ' + PORT));