// ============================================================
// 🖨️ PRINT SERVER v2.0 - WebSocket Client
// ============================================================
// Se instala en el PC del restaurante.
// Toda la configuración se hace desde el dashboard web.
// No necesitas editar ningún archivo manualmente.
// ============================================================

require('dotenv').config();
const { io } = require('socket.io-client');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const PrinterManager = require('./PrinterManager');

// ============================================================
// CONFIGURACION — Lee de config.json (creado desde el dashboard)
// ============================================================
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PORT = process.env.PORT || 9001;

function loadConfig() {
    const defaults = {
        api_url: 'https://api-foodly.onrender.com',
        tenant_id: '',
        printers: {
            cocina: { type: 'none', host: '192.168.1.100', port: 9100 },
            bar: { type: 'none', host: '192.168.1.101', port: 9100 },
            caja: { type: 'none', host: '192.168.1.102', port: 9100 },
        },
    };
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            return { ...defaults, ...saved, printers: { ...defaults.printers, ...saved.printers } };
        }
    } catch (e) { /* usar defaults */ }
    return defaults;
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

let config = loadConfig();

// ============================================================
// INICIALIZAR
// ============================================================
const printerManager = new PrinterManager();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Registrar impresoras desde config
function registerPrinters() {
    for (const [area, cfg] of Object.entries(config.printers)) {
        printerManager.register(area, cfg);
    }
}
registerPrinters();

// ============================================================
// WEBSOCKET - Conectar a la API en la nube
// ============================================================
let socket = null;
let connected = false;

function connectWebSocket() {
    if (!config.tenant_id) {
        printerManager.log('⚠️ No hay TENANT_ID configurado. Abre el dashboard y configúralo.');
        return;
    }

    // Desconectar socket anterior si existe
    if (socket) {
        socket.disconnect();
        socket = null;
        connected = false;
    }

    printerManager.log(`🔌 Conectando a ${config.api_url}...`);

    socket = io(config.api_url, {
        query: { tenantId: config.tenant_id },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 3000,
        reconnectionAttempts: Infinity,
        timeout: 10000,
    });

    socket.on('connect', () => {
        connected = true;
        printerManager.log(`✅ Conectado a la API (socket: ${socket.id})`);
        printerManager.log(`📡 Escuchando eventos del tenant: ${config.tenant_id.substring(0, 8)}...`);
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

    // ── Escuchar precuentas → imprimir verificadora ──
    socket.on('precuenta:generada', async (data) => {
        try {
            printerManager.log(`📋 Precuenta Mesa ${data.mesa_numero} → caja`);
            const text = printerManager.formatPrecuenta(data);
            await printerManager.print('caja', text);
        } catch (err) {
            printerManager.log(`❌ Error imprimiendo precuenta: ${err.message}`);
        }
    });

    // ── Escuchar cierre de caja → imprimir resumen ──
    socket.on('cierre:caja', async (data) => {
        try {
            printerManager.log(`📊 Cierre de caja → ${data.cajero}`);
            const text = printerManager.formatCierreCaja(data);
            await printerManager.print('caja', text);
        } catch (err) {
            printerManager.log(`❌ Error imprimiendo cierre: ${err.message}`);
        }
    });
}

// ============================================================
// HANDLERS DE EVENTOS
// ============================================================

// Mapeo de nombres de áreas (la API puede enviar nombres distintos)
function normalizeArea(area) {
    const map = {
        'barra': 'bar',
        'bar': 'bar',
        'cocina': 'cocina',
        'kitchen': 'cocina',
        'caja': 'caja',
        'cashier': 'caja',
    };
    const normalized = (area || 'cocina').toLowerCase().trim();
    return map[normalized] || normalized;
}

async function handleNuevaComanda(data) {
    const payload = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
    if (!payload) {
        printerManager.log('⚠️ Comanda sin payload');
        return;
    }

    const rawArea = data.area_destino || payload.area || 'cocina';
    const area = normalizeArea(rawArea);
    const text = printerManager.formatComanda(payload);
    const success = await printerManager.print(area, text);

    if (success && data.id) {
        try {
            const response = await fetch(`${config.api_url}/api/v1/comandas/${data.id}/impresa`, {
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
// API LOCAL — Dashboard y configuración
// ============================================================

// Estado general
app.get('/status', (req, res) => {
    res.json({
        server: 'print-server v2.0',
        mode: 'WebSocket',
        api: config.api_url,
        tenant: config.tenant_id || null,
        connected,
        socketId: socket?.id || null,
        uptime: Math.round(process.uptime()),
        ...printerManager.getStatus(),
    });
});

// Obtener configuración actual
app.get('/config', (req, res) => {
    res.json({
        api_url: config.api_url,
        tenant_id: config.tenant_id,
        printers: config.printers,
    });
});

// Guardar configuración completa (API URL + TENANT_ID)
app.put('/config', (req, res) => {
    const { api_url, tenant_id } = req.body;
    const changed = config.tenant_id !== tenant_id || config.api_url !== api_url;

    if (api_url) config.api_url = api_url;
    if (tenant_id !== undefined) config.tenant_id = tenant_id;

    saveConfig(config);
    printerManager.log(`⚙️ Configuración guardada (tenant: ${config.tenant_id?.substring(0, 8) || 'vacío'}...)`);

    // Reconectar si cambió el tenant o la API
    if (changed && config.tenant_id) {
        printerManager.log('🔄 Reconectando con nueva configuración...');
        connectWebSocket();
    }

    res.json({ ok: true, mensaje: 'Configuración guardada', connected });
});

// Guardar configuración de impresora individual
app.put('/config/printer/:area', (req, res) => {
    const { area } = req.params;
    const { type, host, port, name } = req.body;
    config.printers[area] = { type: type || 'none', host, port: parseInt(port) || 9100, name: name || '' };
    saveConfig(config);
    printerManager.register(area, config.printers[area]);
    const detail = type === 'windows' ? `windows: ${name}` : `${type} (${host || 'local'}:${port || 9100})`;
    printerManager.log(`⚙️ Impresora "${area}" → ${detail}`);
    res.json({ ok: true });
});

// Test de impresión
app.post('/test-print/:area', async (req, res) => {
    const { area } = req.params;
    const testText = [
        '', '  *** PRUEBA DE IMPRESION ***',
        '-'.repeat(32),
        `  Area: ${area.toUpperCase()}`,
        `  Fecha: ${new Date().toLocaleString('es-CO')}`,
        '-'.repeat(32),
        '  Si ves esto, la impresora',
        '  esta correctamente configurada!', '',
    ].join('\n');

    const success = await printerManager.print(area, testText);
    res.json({ ok: success, area });
});

// Imprimir factura manualmente
app.post('/print/factura', async (req, res) => {
    try {
        const text = printerManager.formatFactura(req.body);
        const success = await printerManager.print('caja', text);
        res.json({ ok: success });
    } catch (err) {
        res.status(500).json({ ok: false, mensaje: err.message });
    }
});

// Imprimir comanda manualmente
app.post('/print/comanda', async (req, res) => {
    try {
        const area = req.body.area || 'cocina';
        const text = printerManager.formatComanda(req.body);
        const success = await printerManager.print(area, text);
        res.json({ ok: success });
    } catch (err) {
        res.status(500).json({ ok: false, mensaje: err.message });
    }
});

app.get('/logs', (req, res) => res.json(printerManager.logs));

// Escanear red local buscando impresoras (puerto 9100)
app.get('/scan-network', async (req, res) => {
    const net = require('net');
    const os = require('os');

    // Detectar subnet local
    const interfaces = os.networkInterfaces();
    let localIp = '192.168.1.1';
    for (const iface of Object.values(interfaces)) {
        for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) {
                localIp = addr.address;
                break;
            }
        }
    }
    const subnet = localIp.split('.').slice(0, 3).join('.');
    printerManager.log(`🔍 Escaneando red ${subnet}.1-254 en puerto 9100...`);

    const found = [];
    const scanPort = (ip, port, timeout = 1500) => {
        return new Promise(resolve => {
            const sock = new net.Socket();
            sock.setTimeout(timeout);
            sock.on('connect', () => {
                sock.destroy();
                resolve({ ip, port, open: true });
            });
            sock.on('timeout', () => { sock.destroy(); resolve(null); });
            sock.on('error', () => { sock.destroy(); resolve(null); });
            sock.connect(port, ip);
        });
    };

    // Escanear en paralelo (bloques de 30 para no saturar)
    for (let batch = 1; batch <= 254; batch += 30) {
        const promises = [];
        for (let i = batch; i < Math.min(batch + 30, 255); i++) {
            promises.push(scanPort(`${subnet}.${i}`, 9100));
        }
        const results = await Promise.all(promises);
        results.forEach(r => { if (r) found.push(r); });
    }

    printerManager.log(`🔍 Escaneo completo: ${found.length} impresora(s) encontrada(s)`);
    if (found.length > 0) {
        found.forEach(f => printerManager.log(`  🖨️ ${f.ip}:${f.port}`));
    }

    res.json({ ok: true, subnet, localIp, printers: found });
});

// ============================================================
// INICIAR
// ============================================================
app.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║   🖨️  FOODLY PRINT SERVER v2.0                ║');
    console.log('╠═══════════════════════════════════════════════╣');
    console.log(`║  Dashboard:  http://localhost:${PORT}              ║`);
    console.log('║  Toda la configuración se hace desde el       ║');
    console.log('║  dashboard. No necesitas editar archivos.     ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log('');

    if (config.tenant_id) {
        connectWebSocket();
    } else {
        printerManager.log('🟡 Abre el dashboard y configura tu TENANT_ID para comenzar');
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
