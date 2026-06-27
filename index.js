require('dotenv').config();
const express = require('express');
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================================================
// 🛡️ CONFIGURAÇÃO DE SEGURANÇA (CORS E ANTI-SPAM)
// =========================================================

const URLsPermitidas = [
    'http://localhost:5173',
    'https://bot-whatsapp-dibb.onrender.com',
    'https://barbearia-sua-zeta.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        const permitido = URLsPermitidas.some(url => origin.startsWith(url));
        if (permitido) {
            return callback(null, true);
        } else {
            console.log(`🚨 BLOQUEIO CORS: Site não autorizado: ${origin}`);
            return callback(new Error('Acesso bloqueado por segurança (CORS)'), false);
        }
    }
}));

const memoriaDeTentativas = new Map();
function protetorAntiSpam(req, res, next) {
    const ipDoUsuario = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const agora = Date.now();
    const TEMPO_DE_BLOQUEIO = 10 * 60 * 1000; 
    const LIMITE_MAXIMO = 5; 

    if (!memoriaDeTentativas.has(ipDoUsuario)) {
        memoriaDeTentativas.set(ipDoUsuario, { tentativas: 1, primeiroAcesso: agora });
        return next();
    }

    const historico = memoriaDeTentativas.get(ipDoUsuario);
    if (agora - historico.primeiroAcesso > TEMPO_DE_BLOQUEIO) {
        memoriaDeTentativas.set(ipDoUsuario, { tentativas: 1, primeiroAcesso: agora });
        return next();
    }

    historico.tentativas += 1;
    if (historico.tentativas > LIMITE_MAXIMO) {
        return res.status(429).json({ 
            erro: 'Muitas tentativas seguidas. IP bloqueado temporariamente por 10 minutos.' 
        });
    }
    next();
}

// =========================================================
// INICIALIZAÇÃO DO SUPABASE E TRAVAS DE MEMÓRIA
// =========================================================

const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.trim() : null;
const supabaseKey = process.env.SUPABASE_KEY ? process.env.SUPABASE_KEY.trim() : null;

let supabase = null;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Banco de Dados (Supabase) conectado!');
}

let sock;
let isConnected = false;
const pixLembretesEnviados = new Set(); 

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_RESET_SABADO');
    
    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['BarbeariaBot', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            isConnected = true;
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
// ⏰ AGENDADORES CRON (LEMBRETES E FEEDBACK)
// =========================================================

cron.schedule('*/15 * * * *', async () => {
    if (!supabase || !isConnected) return;
    try {
        const agora = new Date();
        const daqui2Horas = new Date(agora.getTime() + 2 * 60 * 60 * 1000);
        const formatadorBrasil = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const agoraLocalStr = formatadorBrasil.format(agora).replace(' ', 'T');
        const daqui2HorasLocalStr = formatadorBrasil.format(daqui2Horas).replace(' ', 'T');

        const { data: agendamentos } = await supabase
            .from('appointments')
            .select('*')
            .in('status', ['aprovado', 'Confirmado', 'confirmado']) 
            .eq('lembrete_enviado', false)
            .gte('time', agoraLocalStr)
            .lte('time', daqui2HorasLocalStr);

        if (agendamentos && agendamentos.length > 0) {
            for (const agendamento of agendamentos) {
                const telefoneCliente = agendamento.phone || agendamento.telefone || agendamento.whatsapp; 
                if (!telefoneCliente) continue;
                const horaFormatada = agendamento.time.split('T')[1].substring(0, 5);
                let numeroWhatsApp = telefoneCliente.toString().replace(/\D/g, '');
                if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;

                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                if (result && result.exists) {
                    const msg = `Olá, *${agendamento.client}*! 💈\n\nPassando para lembrar que seu horário conosco está confirmado para hoje às *${horaFormatada}* com o profissional *${agendamento.barber}*.\n\nEstamos te esperando!`;
                    await sock.sendMessage(result.jid, { text: msg });
                    await supabase.from('appointments').update({ lembrete_enviado: true }).eq('id', agendamento.id);
                }
            }
        }
    } catch (e) { console.error('Erro Cron 2h:', e); }
});

cron.schedule('*/15 * * * *', async () => {
    if (!supabase || !isConnected) return;
    try {
        const agora = new Date();
        const daqui24Horas = new Date(agora.getTime() + 24 * 60 * 60 * 1000);
        const daqui24HorasFim = new Date(daqui24Horas.getTime() + 15 * 60 * 1000);
        const formatadorBrasil = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const daqui24HorasStr = formatadorBrasil.format(daqui24Horas).replace(' ', 'T');
        const daqui24HorasFimStr = formatadorBrasil.format(daqui24HorasFim).replace(' ', 'T');

        const { data: agendamentos } = await supabase
            .from('appointments')
            .select('*')
            .in('status', ['aprovado', 'Confirmado', 'confirmado']) 
            .eq('lembrete_24h_enviado', false) 
            .gte('time', daqui24HorasStr)
            .lte('time', daqui24HorasFimStr);

        if (agendamentos && agendamentos.length > 0) {
            for (const agendamento of agendamentos) {
                const telefoneCliente = agendamento.phone || agendamento.telefone || agendamento.whatsapp; 
                if (!telefoneCliente) continue;
                const horaFormatada = agendamento.time.split('T')[1].substring(0, 5);
                const dataCorte = agendamento.time.split('T')[0];
                const [ano, mes, dia] = dataCorte.split('-');
                let numeroWhatsApp = telefoneCliente.toString().replace(/\D/g, '');
                if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;

                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                if (result && result.exists) {
                    const msg = `Olá, *${agendamento.client}*! 👋\n\nPassando para lembrar que você tem um horário agendado para amanhã, dia *${dia}/${mes}* às *${horaFormatada}* com o profissional *${agendamento.barber}*.\n\nEstamos preparando tudo para te receber!`;
                    await sock.sendMessage(result.jid, { text: msg });
                    await supabase.from('appointments').update({ lembrete_24h_enviado: true }).eq('id', agendamento.id);
                }
            }
        }
    } catch (e) { console.error('Erro Cron 24h:', e); }
});

cron.schedule('0 9 * * *', async () => {
    if (!supabase || !isConnected) return;
    try {
        const ontem = new Date();
        ontem.setDate(ontem.getDate() - 1); 
        const dataOntem = ontem.toISOString().split('T')[0];

        const { data: agendamentos } = await supabase
            .from('appointments')
            .select('*')
            .eq('status', 'Concluído')
            .eq('feedback_enviado', false)
            .gte('time', `${dataOntem}T00:00:00`)
            .lte('time', `${dataOntem}T23:59:59`);

        if (agendamentos && agendamentos.length > 0) {
            for (const agendamento of agendamentos) {
                const telefoneCliente = agendamento.phone || agendamento.telefone || agendamento.whatsapp;
                if (!telefoneCliente) continue;
                const linkAvaliacao = "https://g.page/r/CY060O6MsL4dEAE/review"; 
                const msg = `Olá, *${agendamento.client}*! 👋\n\nPassando para saber o que achou do atendimento de ontem. Poderia deixar uma avaliação rápida pra gente aqui? 👇\n\n${linkAvaliacao}`;
                
                let numeroWhatsApp = telefoneCliente.toString().replace(/\D/g, '');
                if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;

                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                if (result && result.exists) {
                    await sock.sendMessage(result.jid, { text: msg });
                    await supabase.from('appointments').update({ feedback_enviado: true }).eq('id', agendamento.id);
                }
            }
        }
    } catch (e) { console.error('Erro Cron Feedback:', e); }
});

cron.schedule('0 * * * *', async () => {
    if (!supabase || !isConnected) return;
    try {
        const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: agendamentos } = await supabase
            .from('appointments')
            .select('*')
            .eq('status', 'Pendente')
            .lt('created_at', umaHoraAtras);

        if (agendamentos && agendamentos.length > 0) {
            for (const agendamento of agendamentos) {
                if (pixLembretesEnviados.has(agendamento.id)) continue;

                const telefoneCliente = agendamento.phone || agendamento.telefone || agendamento.whatsapp;
                if (!telefoneCliente) continue;
                const msg = `Olá, *${agendamento.client}*! 👋\n\nNotei que você gerou um agendamento com a gente, mas o Pix ainda não foi confirmado.\n\nO seu horário só é garantido após a confirmação. Caso precise, você pode realizar o pagamento direto no nosso site! 😉`;
                
                let numeroWhatsApp = telefoneCliente.toString().replace(/\D/g, '');
                if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;

                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                if (result && result.exists) {
                    await sock.sendMessage(result.jid, { text: msg });
                    pixLembretesEnviados.add(agendamento.id);
                    console.log(`💰 Pix esquecido lembrado uma única vez para ${agendamento.client}`);
                }
            }
        }
    } catch (e) { console.error('Erro Cron Pix:', e); }
});

// =========================================================
// 🚀 ENGINE DE COBRANÇAS FINTECH (ASAAS GATEWAY)
// =========================================================

app.post('/gerar-cobranca', protetorAntiSpam, async (req, res) => {
    const { nomeCliente, telefoneCliente, valorFinal, taxaPlataforma, metodoPagamento, cartao } = req.body;
    
    try {
        if (!sock || !isConnected) return res.status(500).json({ erro: 'Serviço de notificações temporariamente offline.' });
        
        const { data: settings } = await supabase.from('site_settings').select('asaas_wallet_id').eq('id', 1).single();
        const barberWalletId = settings?.asaas_wallet_id;

        if (!barberWalletId) {
            return res.status(400).json({ erro: 'Este estabelecimento ainda não concluiu a configuração de recebimentos.' });
        }

        const customerResponse = await fetch('https://api.asaas.com/v3/customers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'access_token': process.env.ASAAS_API_KEY },
            body: JSON.stringify({ name: nomeCliente, mobilePhone: telefoneCliente })
        });
        const customerData = await customerResponse.json();
        const asaasCustomerId = customerData.id;

        const amanha = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const dataVencimento = amanha.toISOString().split('T')[0];

        const paymentPayload = {
            customer: asaasCustomerId,
            billingType: metodoPagamento === 'PIX' ? 'PIX' : 'CREDIT_CARD',
            value: Number(valorFinal),
            dueDate: dataVencimento,
            description: `Agendamento Online - ${nomeCliente}`,
            split: [
                {
                    walletId: barberWalletId,
                    percentualValue: 100 - Number(taxaPlataforma || 3)
                }
            ]
        };

        if (metodoPagamento === 'CREDIT_CARD' && cartao) {
            const finalCartao = cartao.number.slice(-4);
            paymentPayload.creditCard = {
                holderName: cartao.name,
                number: cartao.number.replace(/\s/g, ''),
                expiryMonth: cartao.expiryMonth,
                expiryYear: cartao.expiryYear,
                ccv: cartao.ccv
            };
            paymentPayload.creditCardHolderInfo = {
                name: cartao.name,
                email: 'cliente@barbearia.com',
                cpfCnpj: cartao.cpf,
                postalCode: '89515000',
                addressNumber: '10',
                phone: telefoneCliente
            };

            const asaasPaymentRes = await fetch('https://api.asaas.com/v3/payments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'access_token': process.env.ASAAS_API_KEY },
                body: JSON.stringify(paymentPayload)
            });

            const paymentData = await asaasPaymentRes.json();

            let numeroWhatsApp = telefoneCliente.toString().replace(/\D/g, '');
            if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;
            const [result] = await sock.onWhatsApp(numeroWhatsApp);

            if (!asaasPaymentRes.ok || paymentData.errors) {
                if (result && result.exists) {
                    await sock.sendMessage(result.jid, { text: `⚠️ Olá, *${nomeCliente}*.\n\nHouve uma instabilidade no processamento do seu cartão com final *${finalCartao}*.\n\nPor favor, tente novamente no site utilizando outro cartão ou alterne para a opção Pix.` });
                }
                throw new Error(paymentData.errors?.[0]?.description || 'Recusa do emissor do cartão.');
            }

            if (result && result.exists) {
                await sock.sendMessage(result.jid, { text: `💳 *Pagamento Confirmado!*\n\nOlá, *${nomeCliente}*, seu pagamento no cartão com final *${finalCartao}* foi aprovado com sucesso.\n\nSeu horário já está garantido na agenda! ✂️` });
            }

            return res.json({ sucesso: true });
        } 
        
        else {
            const asaasPaymentRes = await fetch('https://api.asaas.com/v3/payments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'access_token': process.env.ASAAS_API_KEY },
                body: JSON.stringify(paymentPayload)
            });
            const paymentData = await asaasPaymentRes.json();

            const pixDataRes = await fetch(`https://api.asaas.com/v3/payments/${paymentData.id}/pixQrCode`, {
                method: 'GET',
                headers: { 'access_token': process.env.ASAAS_API_KEY }
            });
            const pixData = await pixDataRes.json();

            return res.json({
                sucesso: true,
                qrCodeImage: pixData.encodedImage,
                copiaECola: pixData.payload
            });
        }

    } catch (error) {
        console.error("Erro no processamento da cobrança:", error);
        res.status(500).json({ erro: error.message });
    }
});

// =========================================================
// 🔔 WEBHOOK DE CONFIRMAÇÃO + EMISSÃO DE NOTA FISCAL (ASAAS)
// =========================================================

app.post('/webhook-pagamento', async (req, res) => {
    const { event, payment, invoice } = req.body;
    console.log(`🔔 [ASAAS WEBHOOK] Evento recebido: ${event}`);

    // LOGICA 1: EMISSÃO DE NOTA APÓS PAGAMENTO
    if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') {
        try {
            const clientRes = await fetch(`https://api.asaas.com/v3/customers/${payment.customer}`, {
                method: 'GET',
                headers: { 'access_token': process.env.ASAAS_API_KEY }
            });
            const clientData = await clientRes.json();
            
            const telefoneLimpo = (clientData.mobilePhone || '').replace(/\D/g, '');
            const finalTelefone = telefoneLimpo.slice(-8);

            if (supabase && finalTelefone) {
                const { data: pendentes } = await supabase.from('appointments').select('*').ilike('status', 'pendente');

                if (pendentes && pendentes.length > 0) {
                    const alvo = pendentes.find(ag => {
                        const telBanco = (ag.phone || ag.telefone || ag.whatsapp || '').replace(/\D/g, '');
                        return telBanco.includes(finalTelefone);
                    });

                    if (alvo) {
                        const { data: atualizado } = await supabase
                            .from('appointments')
                            .update({ status: 'Confirmado', payment_method: payment.billingType === 'PIX' ? 'Pix' : 'Cartão' })
                            .eq('id', alvo.id)
                            .ilike('status', 'pendente')
                            .select();

                        if (atualizado && atualizado.length > 0) {
                            console.log(`🧾 [NOTA FISCAL] Solicitando emissão para o cliente ${alvo.client}...`);
                            
                            try {
                                await fetch('https://api.asaas.com/v3/invoices', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'access_token': process.env.ASAAS_API_KEY },
                                    body: JSON.stringify({
                                        payment: payment.id,
                                        customer: payment.customer,
                                        serviceDescription: `Serviço de Barbearia - ${alvo.service || 'Corte'}`,
                                        value: payment.value,
                                        effectiveDate: new Date().toISOString().split('T')[0],
                                        taxes: { retainIss: false, iss: 0, cofins: 0, csll: 0, inss: 0, ir: 0, pis: 0 }
                                    })
                                });
                            } catch (erroNota) {
                                console.error('❌ Erro ao solicitar emissão da nota:', erroNota);
                            }

                            let numeroWhatsApp = telefoneLimpo;
                            if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;
                            const [result] = await sock.onWhatsApp(numeroWhatsApp);
                            if (result && result.exists) {
                                await sock.sendMessage(result.jid, { text: 'Pagamento confirmado! 🎉 Seu agendamento está garantido e a Nota Fiscal está sendo gerada.' });
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Erro ao liquidar webhook Asaas:", err);
        }
    }

    // LOGICA 2: ENVIO DA NOTA APÓS AUTORIZAÇÃO
    if (event === 'INVOICE_AUTHORIZED') {
        try {
            const pdfUrl = invoice.pdfUrl;
            const clientRes = await fetch(`https://api.asaas.com/v3/customers/${invoice.customer}`, {
                method: 'GET',
                headers: { 'access_token': process.env.ASAAS_API_KEY }
            });
            const clientData = await clientRes.json();
            
            let numeroWhatsApp = (clientData.mobilePhone || '').replace(/\D/g, '');
            if (numeroWhatsApp) {
                if (!numeroWhatsApp.startsWith('55')) numeroWhatsApp = '55' + numeroWhatsApp;
                const [result] = await sock.onWhatsApp(numeroWhatsApp);
                if (result && result.exists) {
                    await sock.sendMessage(result.jid, { 
                        text: `🧾 *Sua Nota Fiscal Chegou!*\n\nAqui está o link para acessar e baixar a sua Nota Fiscal de Serviços:\n\n🔗 ${pdfUrl}` 
                    });
                }
            }
        } catch (err) {
            console.error("Erro ao enviar PDF da nota:", err);
        }
    }

    res.status(200).send('OK');
});

// =========================================================
// ROTAS DE CONTROLE GERAIS
// =========================================================

app.get('/', (req, res) => {
    if (isConnected) res.send('<h1>Bot Conectado! ✅</h1>');
    else res.send('<h1>Bot aguardando conexão...</h1>');
});

process.on('uncaughtException', (err) => console.error('Erro isolado capturado:', err));
process.on('unhandledRejection', (reason) => console.error('Rejeição isolada capturada:', reason));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Servidor Asaas FinTech Ativo na porta ' + PORT));