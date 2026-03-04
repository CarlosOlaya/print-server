// ============================================================
// 🖨️ PRINT SERVER v2.0 - WebSocket Client
// ============================================================
// Se instala en el PC del restaurante.
// Se conecta por WebSocket a la API en la nube (Render)
// y escucha eventos para imprimir:
//   - 'comanda:nueva'    → impresora de cocina/bar
//   - 'factura:cerrada'  → impresora de caja
// ============================================================

require('dotenv').config();
const { io } = require('socket.io-client');
const express = require('express');
const cors = require('cors');
const PrinterManager = require('./PrinterManager');

// ============================================================
// CONFIGURACION
// ============================================================
const API_URL = process.env.API_URL || 'https://api-foodly.onrender.com';
const TENANT_ID = process.env.TENANT_ID;
const PORT = process.env.PORT || 9001;

if (!TENANT_ID) {
    console.warn('⚠️  ADVERTENCIA: TENANT_ID no configurado en .env');
    console.warn('   El servidor arrancará en modo DEMO (sin conectar a la API).');
    console.warn('   Configura tu TENANT_ID para recibir comandas reales.');
    console.warn('');
}

// ============================================================
// INICIALIZAR
// ============================================================
const printerManager = new PrinterManager();
const app = express();
app.use(cors());
app.use(express.json());

// Servir el dashboard web
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// Registrar impresoras según .env
['cocina', 'bar', 'caja'].forEach(area => {
    const type = process.env[`PRINTER_${area.toUpperCase()}_TYPE`] || 'none';
    const host = process.env[`PRINTER_${area.toUpperCase()}_HOST`];
    const port = process.env[`PRINTER_${area.toUpperCase()}_PORT`];
    printerManager.register(area, { type, host, port: parseInt(port) || 9100 });
});

// ============================================================
// WEBSOCKET - Conectar a la API en la nube
// ============================================================
let socket = null;
let connected = false;

function connectWebSocket() {
    printerManager.log(`🔌 Conectando a ${API_URL}...`);

    socket = io(API_URL, {
        query: { tenantId: TENANT_ID },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 3000,
        reconnectionAttempts: Infinity,
        timeout: 10000,
    });

    socket.on('connect', () => {
        connected = true;
        printerManager.log(`✅ Conectado a la API (socket: ${socket.id})`);
        printerManager.log(`📡 Escuchando eventos del tenant: ${TENANT_ID}`);
    });

    socket.on('disconnect', (reason) => {
        connected = false;
        printerManager.log(`⚠️ Desconectado: ${reason}`);
    });

    socket.on('connect_error', (err) => {
        connected = false;
        printerManager.log(`❌ Error de conexión: ${err.message}`);
    });

    socket.on('reconnect', (attemptNumber) => {
        connected = true;
        printerManager.log(`🔄 Reconectado (intento #${attemptNumber})`);
    });

    // ── Escuchar nuevas comandas ──
    socket.on('comanda:nueva', async (data) => {
        try {
            printerManager.log(`🔔 Comanda #${data.numero_comanda} → ${data.area_destino} (Mesa ${data.numero_mesa})`);
            await handleNuevaComanda(data);
        } catch (err) {
            printerManager.log(`❌ Error procesando comanda: ${err.message}`);
        }
    });

    // ── Escuchar facturas cerradas → imprimir ticket ──
    socket.on('factura:cerrada', async (data) => {
        try {
            printerManager.log(`🧾 Factura ${data.numero_factura} cerrada → Mesa ${data.mesa_numero}`);
            const text = printerManager.formatFactura(data);
            await printerManager.print('caja', text);
        } catch (err) {
            printerManager.log(`❌ Error imprimiendo factura: ${err.message}`);
        }
    });
}

// ============================================================
// HANDLERS DE EVENTOS
// ============================================================

async function handleNuevaComanda(data) {
    const payload = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
    if (!payload) {
        printerManager.log('⚠️ Comanda sin payload');
        return;
    }

    // Determinar el área de impresión
    const area = data.area_destino || payload.area || 'cocina';

    // Formatear e imprimir
    const text = printerManager.formatComanda(payload);
    const success = await printerManager.print(area, text);

    // Marcar como impresa en la API
    if (success && data.id) {
        try {
            const response = await fetch(`${API_URL}/api/v1/comandas/${data.id}/impresa`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
            });
            if (response.ok) {
                printerManager.log(`✅ Comanda #${data.numero_comanda} marcada como impresa`);
            }
        } catch (err) {
            printerManager.log(`⚠️ No se pudo marcar como impresa: ${err.message}`);
        }
    }
}

// ============================================================
// MINI API LOCAL (para gestión y pruebas)
// ============================================================

app.get('/status', (req, res) => {
    res.json({
        server: 'print-server v2.0',
        mode: 'WebSocket',
        api: API_URL,
        tenant: TENANT_ID,
        connected,
        socketId: socket?.id || null,
        uptime: Math.round(process.uptime()),
        ...printerManager.getStatus(),
    });
});

app.post('/test-print/:area', async (req, res) => {
    const { area } = req.params;
    const testText = [
        '', '  *** PRUEBA DE IMPRESION ***',
        '-'.repeat(32),
        `  Area: ${area.toUpperCase()}`,
        `  Fecha: ${new Date().toLocaleString('es-CO')}`,
        `  Servidor: ${API_URL}`,
        `  Tenant: ${TENANT_ID}`,
        '-'.repeat(32),
        '  Si ves esto, la impresora',
        '  esta correctamente configurada!', '',
    ].join('\n');

    const success = await printerManager.print(area, testText);
    res.json({ ok: success, area });
});

// Endpoint para imprimir una factura manualmente (desde el frontend)
app.post('/print/factura', async (req, res) => {
    try {
        const factura = req.body;
        const text = printerManager.formatFactura(factura);
        const success = await printerManager.print('caja', text);
        res.json({ ok: success });
    } catch (err) {
        res.status(500).json({ ok: false, mensaje: err.message });
    }
});

// Endpoint para reimprimir una comanda
app.post('/print/comanda', async (req, res) => {
    try {
        const payload = req.body;
        const area = payload.area || 'cocina';
        const text = printerManager.formatComanda(payload);
        const success = await printerManager.print(area, text);
        res.json({ ok: success });
    } catch (err) {
        res.status(500).json({ ok: false, mensaje: err.message });
    }
});

app.get('/logs', (req, res) => res.json(printerManager.logs));

// Endpoint para reconfigurar impresoras en caliente
app.put('/config/printer/:area', (req, res) => {
    const { area } = req.params;
    const { type, host, port } = req.body;
    printerManager.register(area, { type: type || 'none', host, port: parseInt(port) || 9100 });
    printerManager.log(`⚙️ Impresora "${area}" reconfigurada → ${type} (${host || 'local'}:${port || 9100})`);
    res.json({ ok: true, mensaje: `Impresora ${area} actualizada` });
});

// ============================================================
// INICIAR
// ============================================================
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   🖨️  PRINT SERVER v2.0 — WebSocket Mode     ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Local API:  http://localhost:${PORT}             ║`);
    console.log(`║  Cloud API:  ${API_URL}    ║`);
    console.log(`║  Tenant:     ${TENANT_ID?.substring(0, 20)}...  ║`);
    console.log('║  Impresoras: tipo "none" = simulado          ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');

    // Conectar WebSocket solo si hay TENANT_ID
    if (TENANT_ID) {
        connectWebSocket();
    } else {
        printerManager.log('🟡 Modo DEMO — Dashboard listo, configura TENANT_ID para conectar');
    }

    // Abrir el dashboard en el navegador
    const url = `http://localhost:${PORT}`;
    try {
        const { exec } = require('child_process');
        if (process.platform === 'win32') exec(`start ${url}`);
        else if (process.platform === 'darwin') exec(`open ${url}`);
        else exec(`xdg-open ${url}`);
    } catch (e) { /* silenciar */ }
});

process.on('SIGINT', () => {
    printerManager.log('🛑 Cerrando...');
    if (socket) socket.disconnect();
    process.exit(0);
});
