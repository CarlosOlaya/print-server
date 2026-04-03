// ============================================================
// PRINTER MANAGER - Gestiona las impresoras del restaurante
// ============================================================
// Soporta:
//   - 'network'  → Impresora TCP/IP por red (ESC/POS directo)
//   - 'windows'  → Impresora USB/compartida vía Windows (usa el nombre de impresora)
//   - 'none'     → Modo prueba (imprime en consola)

class PrinterManager {
    constructor() {
        this.printers = {};
        this.logs = [];
        this.maxLogs = 200;
        // Cola de impresión por impresora
        this._queues = {};   // { area: [{ text, resolve, reject }] }
        this._printing = {}; // { area: boolean }
        // Zona horaria del tenant (configurable desde config.json)
        this._tz = 'America/Bogota';
    }

    // Configurar zona horaria del tenant
    setTimezone(tz) {
        this._tz = tz || 'America/Bogota';
        this.log(`🕐 Zona horaria configurada: ${this._tz}`);
    }

    // Registrar una impresora por area
    register(area, config) {
        this.printers[area] = {
            type: config.type || 'none',
            host: config.host,
            port: config.port || 9100,
            name: config.name || '',  // Nombre de impresora Windows (ej: "CAJAP")
            status: 'registrada',
            lastPrint: null,
            printCount: 0,
        };
        const detail = config.type === 'windows' ? `windows: ${config.name}`
            : config.type === 'network' ? `network: ${config.host}:${config.port || 9100}`
                : 'simulado';
        this.log(`📠 Impresora "${area}" registrada (${detail})`);
    }

    // Encolar impresión (evita colisiones si llegan varias comandas a la vez)
    async print(area, text) {
        const printer = this.printers[area];

        if (!printer) {
            this.log(`⚠️ No hay impresora para area: ${area}`);
            if (this.printers['caja']) {
                this.log(`↪️ Redirigiendo a impresora de caja`);
                return this.print('caja', text);
            }
            return false;
        }

        // Encolar el trabajo
        return new Promise((resolve, reject) => {
            if (!this._queues[area]) this._queues[area] = [];
            this._queues[area].push({ text, resolve, reject });
            this._processQueue(area);
        });
    }

    // Procesar cola de una impresora (un trabajo a la vez)
    async _processQueue(area) {
        if (this._printing[area]) return; // ya procesando
        if (!this._queues[area] || this._queues[area].length === 0) return;

        this._printing[area] = true;
        const job = this._queues[area].shift();
        const printer = this.printers[area];

        try {
            await this._sendToPrinter(printer, job.text, area);
            printer.status = 'ok';
            printer.lastPrint = new Date().toISOString();
            printer.printCount++;
            this.log(`✅ Impreso en ${area} (#${printer.printCount})`);
            job.resolve(true);
        } catch (error) {
            printer.status = 'error: ' + error.message;
            this.log(`❌ Error imprimiendo en ${area}: ${error.message}`);
            job.resolve(false);
        }

        this._printing[area] = false;

        // Esperar un momento breve entre trabajos para que la impresora respire
        if (this._queues[area] && this._queues[area].length > 0) {
            setTimeout(() => this._processQueue(area), 300);
        }
    }

    // Enviar datos directamente a la impresora
    async _sendToPrinter(printer, text, area) {
        if (printer.type === 'network') {
            await this.printNetwork(printer, text);
        } else if (printer.type === 'windows') {
            await this.printWindows(printer, text, area);
        } else if (printer.type === 'none') {
            this.log(`🖨️ [SIMULADO - ${area}] Imprimiendo ${text.length} caracteres`);
            console.log('\n' + '='.repeat(40));
            console.log(`IMPRESION SIMULADA → ${area.toUpperCase()}`);
            console.log('='.repeat(40));
            console.log(text);
            console.log('='.repeat(40) + '\n');
        }
    }

    // Imprimir por red TCP (ESC/POS directo)
    async printNetwork(printer, text) {
        const net = require('net');

        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            const timeout = setTimeout(() => {
                client.destroy();
                reject(new Error(`Timeout conectando a ${printer.host}:${printer.port}`));
            }, 5000);

            client.connect(printer.port, printer.host, () => {
                clearTimeout(timeout);

                const ESC = '\x1B';
                const GS = '\x1D';
                const commands = [
                    ESC + '@',                       // Inicializar
                    GS + 'L' + '\x00' + '\x00',    // Margen izquierdo = 0
                    text,
                    '\n',
                    GS + 'V' + '\x00',              // Cortar papel
                ].join('');

                client.write(commands, () => {
                    client.end();
                    resolve();
                });
            });

            client.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    // Imprimir por USB/compartida via Windows
    async printWindows(printer, text, area) {
        const fs = require('fs');
        const path = require('path');
        const { exec } = require('child_process');
        const os = require('os');

        const printerName = printer.name;
        if (!printerName) {
            throw new Error('Nombre de impresora Windows no configurado');
        }

        // Escribir datos a archivo temporal con comandos ESC/POS
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `foodly_print_${area}_${Date.now()}.bin`);

        const ESC = '\x1B';
        const GS = '\x1D';
        const rawData = Buffer.from(
            ESC + '@' +                          // Inicializar
            GS + 'L' + '\x00' + '\x00' +       // Margen izquierdo = 0
            text +
            '\n' +
            GS + 'V' + '\x00',                  // Cortar papel
            'latin1'
        );

        fs.writeFileSync(tmpFile, rawData);
        this.log(`🖨️ [WINDOWS - ${area}] Enviando a "${printerName}"...`);

        return new Promise((resolve, reject) => {
            // Usar PowerShell para enviar raw data a la impresora
            const psCmd = `
                $printer = Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Name='${printerName.replace(/'/g, "''")}}'"
                if (-not $printer) {
                    # Intentar enviar via copy al puerto compartido
                    Copy-Item '${tmpFile.replace(/'/g, "''")}' -Destination '\\\\localhost\\${printerName.replace(/'/g, "''")}' -Force
                } else {
                    Copy-Item '${tmpFile.replace(/'/g, "''")}' -Destination '\\\\localhost\\${printerName.replace(/'/g, "''")}' -Force
                }
            `.trim();

            // Método más simple y confiable: usar "print" de Windows
            // o copiar directamente al share de la impresora
            const cmd = `copy /b "${tmpFile}" "\\\\localhost\\${printerName}"`;

            exec(cmd, { shell: 'cmd.exe' }, (error, stdout, stderr) => {
                // Limpiar archivo temporal
                try { fs.unlinkSync(tmpFile); } catch (e) { /* ok */ }

                if (error) {
                    // Si copy falla, intentar con PowerShell Out-Printer
                    const psAlt = `powershell -Command "Get-Content '${tmpFile}' -Raw | Out-Printer -Name '${printerName}'"`;
                    // Intentar método alternativo con raw file
                    const cmd2 = `powershell -Command "$bytes=[System.IO.File]::ReadAllBytes('${tmpFile}'); $port=New-Object System.IO.Ports.SerialPort; $handler=[System.Drawing.Printing.PrintDocument]::new(); $handler.PrinterSettings.PrinterName='${printerName}'"`;

                    // Método directo: usar WMIC
                    this.log(`⚠️ "copy" falló, usa impresora compartida. Error: ${error.message}`);
                    reject(new Error(`No se pudo imprimir en "${printerName}". Comparte la impresora en Windows (click derecho → Propiedades → Compartir → Compartir esta impresora)`));
                    return;
                }

                this.log(`📄 Datos enviados a ${printerName}`);
                resolve();
            });
        });
    }

    // ── Helper: quitar acentos para impresora térmica ──
    _sanitize(text) {
        return (text || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')  // quita diacríticos (á→a, ó→o, ú→u, etc.)
            .replace(/[^\x20-\x7E\n]/g, '');  // solo caracteres imprimibles ASCII
    }

    // ── Helper: hora simple sin caracteres unicode del locale ──
    _horaSimple(date) {
        const now = date || new Date();
        try {
            return this._sanitize(now.toLocaleTimeString('es-CO', {
                timeZone: this._tz,
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
            }));
        } catch (e) {
            // Fallback si el timezone no es valido
            let h = now.getHours();
            const m = String(now.getMinutes()).padStart(2, '0');
            const ampm = h >= 12 ? 'PM' : 'AM';
            h = h % 12 || 12;
            return `${h}:${m} ${ampm}`;
        }
    }

    // ── Helper: fecha en zona horaria del tenant ──
    _fechaSimple(date) {
        const now = date || new Date();
        try {
            return this._sanitize(now.toLocaleDateString('es-CO', {
                timeZone: this._tz,
            }));
        } catch (e) {
            return now.toLocaleDateString('es-CO');
        }
    }

    // ── Helper: fecha+hora completa en zona horaria ──
    _fechaHoraSimple(date) {
        const now = date || new Date();
        try {
            return this._sanitize(now.toLocaleString('es-CO', {
                timeZone: this._tz,
            }));
        } catch (e) {
            return now.toLocaleString('es-CO');
        }
    }

    // ══════════════════════════════════════════
    // COMANDA — mismo estilo limpio que factura
    // ══════════════════════════════════════════
    formatComanda(payload) {
        if (payload.tipo_comanda === 'anulacion') {
            return this.formatComandaAnulacion(payload);
        }

        const ESC = '\x1B';
        const BOLD = ESC + '\x45\x01';
        const BOLD_OFF = ESC + '\x45\x00';

        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const now = new Date();
        const fecha = this._fechaSimple(now);
        const hora = payload.hora ? this._sanitize(String(payload.hora)) : this._horaSimple(now);

        // Header
        lines.push(this._center(`COMANDA #${payload.comanda} | ${this._sanitize((payload.area || '').toUpperCase())}`, W));
        lines.push(sep2);

        // Info mesa
        const mesaLabel = this._sanitize(String(payload.mesa_nombre || ('Mesa: ' + payload.mesa)).toUpperCase());
        lines.push(`${BOLD}${mesaLabel}${BOLD_OFF}   Mesero: ${this._sanitize(payload.mesero || '')}`);
        if (payload.comensales) lines.push(`Personas: ${payload.comensales}`);
        lines.push(`Fecha: ${fecha}   Hora: ${hora}`);
        lines.push(sep);

        // Encabezado tabla
        lines.push('CANT  PRODUCTO');
        lines.push(sep);

        // Items
        (payload.items || []).forEach(item => {
            const nombre = this._sanitize((item.nombre || item.producto || '').toUpperCase());
            const cant = String(item.cantidad || 1).padStart(3, ' ');
            const nombreTrunc = nombre.substring(0, 42);

            // Nombre + cantidad en negrita
            lines.push(BOLD + `${cant}  ${nombreTrunc}` + BOLD_OFF);

            // Comentario en texto normal, indentado
            if (item.comentario) {
                lines.push(`      > ${this._sanitize(item.comentario)}`);
            }

            // Línea en blanco entre items
            lines.push('');
        });

        lines.push(sep2);
        lines.push('');
        lines.push('');
        lines.push('');

        return lines.join('\n');
    }

    // ══════════════════════════════════════════
    // ANULACIÓN — mismo estilo limpio, diferenciado
    // ══════════════════════════════════════════
    formatComandaAnulacion(payload) {
        const ESC = '\x1B';
        const BOLD = ESC + '\x45\x01';
        const BOLD_OFF = ESC + '\x45\x00';

        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const sepX = 'X'.repeat(W);
        const now = new Date();
        const fecha = this._fechaSimple(now);
        const hora = payload.hora ? this._sanitize(String(payload.hora)) : this._horaSimple(now);

        // Header ANULACIÓN
        lines.push(sep2);
        lines.push(BOLD + this._center('*** ANULACION ***', W) + BOLD_OFF);
        lines.push(this._center(`COMANDA #${payload.comanda} | ${this._sanitize((payload.area || '').toUpperCase())}`, W));
        lines.push(sep2);

        // Info mesa
        const mesaLabel = this._sanitize(String(payload.mesa_nombre || ('Mesa: ' + payload.mesa)).toUpperCase());
        lines.push(`${BOLD}${mesaLabel}${BOLD_OFF}   Mesero: ${this._sanitize(payload.mesero || '')}`);
        lines.push(`Fecha: ${fecha}   Hora: ${hora}`);
        lines.push(sep);

        // Motivo
        if (payload.motivo) {
            lines.push(BOLD + `MOTIVO: ${this._sanitize(payload.motivo.toUpperCase())}` + BOLD_OFF);
            lines.push(sep);
        }

        // Encabezado
        lines.push(BOLD + this._center('** NO PREPARAR **', W) + BOLD_OFF);
        lines.push(sep);

        // Items
        (payload.items || []).forEach(item => {
            const nombre = this._sanitize((item.nombre || item.producto || '').toUpperCase());
            const cant = String(Math.abs(Number(item.cantidad) || 1)).padStart(3, ' ');
            const nombreTrunc = nombre.substring(0, 42);

            lines.push(BOLD + `${cant}  ${nombreTrunc}` + BOLD_OFF);

            if (item.comentario) {
                lines.push(`      > ${this._sanitize(item.comentario)}`);
            }

            lines.push('');
        });

        lines.push(sepX);
        lines.push(BOLD + this._center('** ANULADO **', W) + BOLD_OFF);
        lines.push(sepX);
        lines.push('');
        lines.push('');
        lines.push('');

        return lines.join('\n');
    }

    // ══════════════════════════════════════════
    // PEDIDO — tirilla de cobro
    // ══════════════════════════════════════════
    //
    // Contrato del parámetro `factura`:
    //   Ver api-foodly/src/facturacion/interfaces/factura-cerrada.payload.ts
    //
    // Campos utilizados:
    //   .tenant_nombre  string   — Nombre del restaurante
    //   .nit            string   — NIT del restaurante
    //   .numero_factura string   — Ej: 'PED-00123'
    //   .mesa_nombre    string   — Ej: 'Terraza 1'
    //   .mesa_numero    number   — Número de la mesa (fallback)
    //   .mesero         string   — Nombre del mesero
    //   .items[]        array    — Items del pedido
    //     .plato / .nombre   string  — Nombre del plato
    //     .cantidad          number
    //     .precio_unitario   number
    //     .descuento_porcentaje number
    //     .descuento_monto     number
    //     .es_cortesia         boolean
    //   .subtotal       number   — Subtotal (bruto - descuentos)
    //   .descuento_monto number  — Descuento total aplicado
    //   .monto_iva      number   — IVA calculado
    //   .propina         number  — Servicio total
    //   .total           number  — Total de la factura
    //   .metodo_pago     string  — 'efectivo', 'efectivo+tarjeta', etc.
    //   .pagos[]         array   — Desglose por método (SIEMPRE >= 1 elemento)
    //     .metodo          string  — Clave: 'efectivo', 'tarjeta', etc.
    //     .monto           number  — Venta neta de este método
    //     .propina         number  — Servicio de este método
    //
    /**
     * Genera texto ESC/POS para la tirilla de cobro de un pedido.
     *
     * @param {object} factura — Payload del evento 'factura:cerrada'.
     *   Contrato definido en FacturaCerradaPayload (api-foodly).
     * @returns {string} Texto formateado para impresora térmica de 48 columnas.
     */
    formatFactura(factura) {
        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const now = new Date();
        const fecha = this._fechaSimple(now);
        const hora = this._horaSimple(now);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        // ── Header: nombre restaurante y NIT ──
        if (factura.tenant_nombre) {
            lines.push(this._center(factura.tenant_nombre.toUpperCase(), W));
        }
        if (factura.nit) lines.push(this._center(`NIT: ${factura.nit}`, W));
        lines.push(sep);

        // ── Número de documento ──
        lines.push(this._center(factura.numero_factura || 'PEDIDO', W));
        lines.push(sep);

        // ── Info: fecha, mesa, mesero ──
        lines.push(`Fecha: ${fecha}        Hora: ${hora}`);
        lines.push(`${factura.mesa_nombre || ('Mesa: ' + (factura.mesa_numero || ''))}`);
        lines.push(`Mesero: ${factura.mesero || ''}`);
        lines.push(sep);

        // ── Tabla de items ──
        if (factura.items) {
            lines.push('CANT  PRODUCTO                V.UNI    TOTAL');
            lines.push(sep);
            factura.items.forEach(item => {
                const cant = String(item.cantidad || 1).padStart(3, ' ');
                const nombre = (item.nombre || item.plato || '').substring(0, 22).padEnd(22, ' ');
                const precio = Number(item.precio_unitario) || 0;
                const cantNum = Number(item.cantidad) || 1;
                const descPct = Number(item.descuento_porcentaje) || 0;
                const descMonto = Number(item.descuento_monto) || 0;
                const totalBruto = precio * cantNum;
                const totalNeto = totalBruto - descMonto;
                const esCortesia = Boolean(item.es_cortesia);

                if (esCortesia) {
                    const vuni = this._rpad(fmt(precio), 8);
                    lines.push(`${cant}  ${nombre} ${vuni}       $0`);
                    lines.push(`      ** CORTESIA **`);
                } else if (descPct > 0) {
                    const vuni = this._rpad(fmt(precio), 8);
                    const total = this._rpad(fmt(totalNeto), 8);
                    lines.push(`${cant}  ${nombre} ${vuni} ${total}`);
                    lines.push(`      Dcto -${descPct}% (-$${fmt(descMonto)})`);
                } else {
                    const vuni = this._rpad(fmt(precio), 8);
                    const total = this._rpad(fmt(totalBruto), 8);
                    lines.push(`${cant}  ${nombre} ${vuni} ${total}`);
                }
            });
            lines.push(sep);
        }

        // ── Totales ──
        lines.push(this._lr('SUBTOTAL:', `$${fmt(factura.subtotal)}`, W));
        if (factura.descuento_monto > 0) {
            lines.push(this._lr('DESCUENTO:', `-$${fmt(factura.descuento_monto)}`, W));
        }
        if (factura.monto_iva > 0) {
            lines.push(this._lr('IVA:', `$${fmt(factura.monto_iva)}`, W));
        }
        if (factura.propina > 0) {
            lines.push(this._lr('SERVICIO:', `$${fmt(factura.propina)}`, W));
        }
        lines.push(sep2);
        lines.push(this._lr('TOTAL PEDIDO:', `$ ${fmt(factura.total)}`, W));
        lines.push(sep2);

        // ── Sección FORMAS DE PAGO ──
        // Mapa de claves internas → etiquetas legibles para la tirilla
        const metodoLabels = {
            efectivo: 'Efectivo', tarjeta: 'Tarjeta', datafono: 'Tarjeta',
            transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata',
            bold: 'Bold', rappi_pay: 'Rappi Pay', pse: 'PSE',
            bonos: 'Bonos', credito: 'Credito', mixto: 'Mixto',
        };
        const labelMetodo = (m) => {
            const key = (m || '').toLowerCase();
            if (key.includes('+')) {
                return key.split('+').map(k => metodoLabels[k] || k).join(' + ');
            }
            return metodoLabels[key] || m || 'Efectivo';
        };

        // Determinar si es pago dividido (>1 método en el array pagos)
        const tienePagos = factura.pagos && factura.pagos.length > 0;
        const esDividido = tienePagos && factura.pagos.length > 1;

        if (esDividido) {
            // ── PAGO DIVIDIDO: desglose detallado por método ──
            lines.push(this._center('FORMAS DE PAGO (DIVIDIDO)', W));
            lines.push(sep);

            for (const p of factura.pagos) {
                const metodoLabel = labelMetodo(p.metodo || p.metodo_pago);
                const monto = Number(p.monto) || 0;
                const propina = Number(p.propina) || 0;
                const subtotalMetodo = monto + propina;

                lines.push(metodoLabel + ':');
                lines.push(this._lr('  Subtotal:', `$${fmt(monto)}`, W));
                if (propina > 0) {
                    lines.push(this._lr('  + Servicio:', `$${fmt(propina)}`, W));
                }
                lines.push(this._lr('  Total metodo:', `$${fmt(subtotalMetodo)}`, W));
                lines.push(sep);
            }

            // Línea de verificación: suma de todos los métodos
            const totalCobrado = factura.pagos.reduce((s, p) =>
                s + (Number(p.monto) || 0) + (Number(p.propina) || 0), 0);
            lines.push(this._lr('TOTAL COBRADO:', `$${fmt(totalCobrado)}`, W));
        } else if (tienePagos) {
            // ── PAGO SIMPLE: un solo método ──
            lines.push(this._center('FORMAS DE PAGO', W));
            lines.push(sep);
            const p = factura.pagos[0];
            const metodoStr = labelMetodo(p.metodo || p.metodo_pago).padEnd(14, ' ');
            lines.push(this._lr(metodoStr + ':', `$${fmt(p.monto)}`, W));
            if (Number(p.propina) > 0) {
                lines.push(this._lr('  + Servicio:', `$${fmt(p.propina)}`, W));
            }
        } else if (factura.metodo_pago) {
            // ── FALLBACK: facturas legacy sin array pagos ──
            lines.push(this._center('FORMAS DE PAGO', W));
            lines.push(sep);
            const metodoStr = labelMetodo(factura.metodo_pago);
            lines.push(this._lr(metodoStr + ':', `$${fmt(factura.total)}`, W));
        }

        lines.push(sep);
        lines.push('');
        lines.push(this._center('** SOLO PARA CONTROL INTERNO **', W));
        lines.push(this._center('Gracias por su visita!', W));
        lines.push(this._footer());

        return lines.join('\n');
    }

    // ══════════════════════════════════════════
    // PRECUENTA — Verificación de Pedido
    // ══════════════════════════════════════════
    formatPrecuenta(data) {
        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const now = new Date();
        const fecha = this._fechaSimple(now);
        const hora = this._horaSimple(now);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        // Header
        lines.push(sep);
        lines.push(this._center('VERIFICACION DE PEDIDO', W));
        if (data.tenant_nombre) {
            lines.push(this._center(data.tenant_nombre.toUpperCase(), W));
        }
        lines.push(sep);

        // Info
        lines.push(`Fecha: ${fecha}        Hora: ${hora}`);
        lines.push(`${data.mesa_nombre || ('MESA: ' + (data.mesa_numero || ''))}`);
        lines.push(`MESERO: ${data.mesero || ''}`);
        lines.push(sep);

        // Tabla items
        if (data.items) {
            lines.push('CANT  PRODUCTO                V.UNI    TOTAL');
            lines.push(sep);
            data.items.forEach(item => {
                const cant = String(item.cantidad || 1).padStart(3, ' ');
                const nombre = (item.nombre || item.plato || '').substring(0, 22).padEnd(22, ' ');
                const precio = Number(item.precio_unitario) || 0;
                const cantNum = Number(item.cantidad) || 1;
                const descPct = Number(item.descuento_porcentaje) || 0;
                const descMonto = Number(item.descuento_monto) || 0;
                const totalBruto = precio * cantNum;
                const totalNeto = totalBruto - descMonto;
                const esCortesia = Boolean(item.es_cortesia);

                if (esCortesia) {
                    // Cortesía: mostrar precio original y $0
                    const vuni = this._rpad(fmt(precio), 8);
                    lines.push(`${cant}  ${nombre} ${vuni}       $0`);
                    lines.push(`      ** CORTESIA **`);
                } else if (descPct > 0) {
                    // Descuento parcial
                    const vuni = this._rpad(fmt(precio), 8);
                    const total = this._rpad(fmt(totalNeto), 8);
                    lines.push(`${cant}  ${nombre} ${vuni} ${total}`);
                    lines.push(`      Dcto -${descPct}% (-$${fmt(descMonto)})`);
                } else {
                    // Sin descuento
                    const vuni = this._rpad(fmt(precio), 8);
                    const total = this._rpad(fmt(totalBruto), 8);
                    lines.push(`${cant}  ${nombre} ${vuni} ${total}`);
                }
            });
            lines.push(sep);
        }

        // Subtotal
        lines.push(this._lr('SUBTOTAL:', `$${fmt(data.subtotal)}`, W));

        // Detalle de cargos
        if (data.descuento_mesa > 0) {
            lines.push(this._lr('Descuento:', `-$${fmt(data.descuento_mesa)}`, W));
        }
        // Propina sugerida
        const esDelivery = data.mesa_nombre && /domicilio|llevar/i.test(data.mesa_nombre);

        if (data.monto_servicio > 0 && !esDelivery) {
            lines.push(this._lr('Servicio:', `$${fmt(data.monto_servicio)}`, W));
        }
        if (data.monto_iva > 0) {
            lines.push(this._lr('IVA:', `$${fmt(data.monto_iva)}`, W));
        }

        lines.push(sep);


        // Propina sugerida
        const propinaPct = Number(data.porcentaje_propina_sugerida) || 10;
        const propinaMonto = Number(data.propina_sugerida) || Math.round((Number(data.subtotal) || 0) * propinaPct / 100);

        if (propinaMonto > 0 && !esDelivery) {
            lines.push(this._lr('SERVICIO SUGERIDO ' + `(${propinaPct}%)` + ' :', `$ ${fmt(propinaMonto || 0)}`, W));
            lines.push(sep);
            lines.push(this._lr('TOTAL + SERVICIO:', `$ ${fmt((Number(data.total) || 0) + propinaMonto)}`, W));
        } else {
            // El total (sin propina voluntaria)
            lines.push(this._lr('TOTAL A PAGAR:', `$ ${fmt(data.total)}`, W));
        }

        lines.push(sep2);
        lines.push('');
        lines.push(this._center('** SOLO PARA CONTROL INTERNO **', W));
        lines.push(this._center('Documento de verificacion', W));
        lines.push(this._footer());

        // ── SEGUNDA TIRILLA: DATOS DE CLIENTE (DOMICILIO/LLEVAR) ──
        if (esDelivery && data.cliente) {
            const ESC = '\x1B';
            const BOLD = ESC + '\x45\x01';
            const BOLD_OFF = ESC + '\x45\x00';

            lines.push('');
            lines.push('');
            lines.push('\x1D\x56\x00'); // CORTAR PAPEL
            lines.push('\x1B\x40');     // INICIALIZAR IMPRESORA
            lines.push('\x1D\x4C\x00\x00'); // MARGEN IZQUIERDO = 0
            lines.push(...this._formatDatosEntrega(data, W, sep, sep2, BOLD, BOLD_OFF));
        }

        return lines.join('\n');
    }

    // ══════════════════════════════════════════
    // DATOS DE CLIENTE (Impresión Individual)
    // ══════════════════════════════════════════
    formatDatosCliente(data) {
        const W = 48;
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const ESC = '\x1B';
        const BOLD = ESC + '\x45\x01';
        const BOLD_OFF = ESC + '\x45\x00';

        const lines = [];
        lines.push(this._header(data));
        lines.push('');
        if (data.cliente) {
            lines.push(...this._formatDatosEntrega(data, W, sep, sep2, BOLD, BOLD_OFF));
        } else {
            lines.push(this._center('No hay datos de cliente.', W));
            lines.push('');
            lines.push(sep2);
        }
        lines.push(this._footer());
        return lines.join('\n');
    }

    _formatDatosEntrega(data, W, sep, sep2, BOLD, BOLD_OFF) {
        const lines = [];
        lines.push(sep2);
        lines.push(BOLD + this._center('DATOS PARA ENTREGA', W) + BOLD_OFF);
        lines.push(this._center(data.mesa_nombre ? String(data.mesa_nombre).toUpperCase() : '', W));
        lines.push(sep2);
        lines.push('');

        if (data.cliente.nombre) {
            lines.push(BOLD + 'Cliente: ' + BOLD_OFF + this._sanitize(data.cliente.nombre));
        }
        if (data.cliente.telefono) {
            lines.push(BOLD + 'Telefono: ' + BOLD_OFF + this._sanitize(data.cliente.telefono));
        }
        if (data.cliente.direccion) {
            lines.push(BOLD + 'Direccion: ' + BOLD_OFF + this._sanitize(data.cliente.direccion));
        }
        if (data.cliente.notas) {
            lines.push(sep);
            lines.push(BOLD + 'Notas:' + BOLD_OFF);
            lines.push(this._sanitize(data.cliente.notas));
        }

        lines.push('');
        lines.push(sep2);
        return lines;
    }

    // ══════════════════════════════════════════
    // CIERRE DE CAJA — Resumen financiero del turno
    // ══════════════════════════════════════════
    formatCierreCaja(data) {
        const ESC = '\x1B';
        const BOLD = ESC + '\x45\x01';
        const BOLD_OFF = ESC + '\x45\x00';

        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        // ── Header ──
        if (data.tenant_nombre) {
            lines.push(this._center(this._sanitize(data.tenant_nombre.toUpperCase()), W));
        }
        lines.push(sep2);
        lines.push(BOLD + this._center('CIERRE DE CAJA', W) + BOLD_OFF);
        lines.push(sep2);

        // ── Info del turno ──
        lines.push(this._lr('Cajero:', this._sanitize(data.cajero || ''), W));
        if (data.fecha_apertura) {
            lines.push(this._lr('Apertura:', this._fechaHoraSimple(new Date(data.fecha_apertura)), W));
        }
        lines.push(this._lr('Cierre:', this._fechaHoraSimple(new Date(data.fecha_cierre || Date.now())), W));
        lines.push(sep);

        // ── Ventas por metodo de pago ──
        lines.push(BOLD + 'VENTAS POR METODO DE PAGO' + BOLD_OFF);
        lines.push(sep);
        lines.push(this._lr('  Efectivo:', `$${fmt(data.total_efectivo)}`, W));
        lines.push(this._lr('  Datafono:', `$${fmt(data.total_datafono)}`, W));
        lines.push(this._lr('  Transferencia:', `$${fmt(data.total_transferencia)}`, W));
        if (data.total_credito > 0) {
            lines.push(this._lr('  Credito:', `$${fmt(data.total_credito)}`, W));
        }
        lines.push(sep);
        lines.push(BOLD + this._lr('TOTAL VENTAS:', `$${fmt(data.total_ventas)}`, W) + BOLD_OFF);
        lines.push('');

        // ── Servicio ──
        lines.push(BOLD + 'SERVICIO' + BOLD_OFF);
        lines.push(sep);
        if (data.propina_efectivo > 0) lines.push(this._lr('  Efectivo:', `$${fmt(data.propina_efectivo)}`, W));
        if (data.propina_datafono > 0) lines.push(this._lr('  Datafono:', `$${fmt(data.propina_datafono)}`, W));
        if (data.propina_transferencia > 0) lines.push(this._lr('  Transferencia:', `$${fmt(data.propina_transferencia)}`, W));
        lines.push(sep);
        lines.push(BOLD + this._lr('TOTAL SERVICIO:', `$${fmt(data.total_propinas)}`, W) + BOLD_OFF);
        lines.push('');

        // ── Total ingreso ──
        const totalIngreso = (Number(data.total_ventas) || 0) + (Number(data.total_propinas) || 0);
        lines.push(sep2);
        lines.push(BOLD + this._lr('TOTAL INGRESO:', `$${fmt(data.total_ingreso || totalIngreso)}`, W) + BOLD_OFF);
        lines.push(sep2);
        lines.push('');

        // ── Descuentos y cortesias ──
        const totalDesc = Number(data.total_descuentos) || 0;
        const totalCort = Number(data.total_cortesias) || 0;
        if (totalDesc > 0 || totalCort > 0) {
            lines.push(BOLD + 'DESCUENTOS Y CORTESIAS' + BOLD_OFF);
            lines.push(sep);
            if (data.total_descuentos_mesa > 0) lines.push(this._lr('  Dcto Mesa:', `-$${fmt(data.total_descuentos_mesa)}`, W));
            if (data.total_descuentos_items > 0) lines.push(this._lr('  Dcto Items:', `-$${fmt(data.total_descuentos_items)}`, W));
            if (totalCort > 0) lines.push(this._lr('  Cortesias:', `-$${fmt(totalCort)}`, W));
            lines.push(sep);
            lines.push(BOLD + this._lr('TOTAL DCTOS:', `-$${fmt(totalDesc + totalCort)}`, W) + BOLD_OFF);
            lines.push('');
        }

        // ── Anulaciones ──
        if (data.num_anulaciones > 0 || data.items_anulados > 0) {
            lines.push(BOLD + 'ANULACIONES' + BOLD_OFF);
            lines.push(sep);
            if (data.num_anulaciones > 0) lines.push(this._lr('  Pedidos anulados:', `${data.num_anulaciones}`, W));
            if (data.monto_anulaciones > 0) lines.push(this._lr('  Monto anulado:', `$${fmt(data.monto_anulaciones)}`, W));
            if (data.items_anulados > 0) lines.push(this._lr('  Items anulados:', `${data.items_anulados}`, W));
            lines.push('');
        }

        // ── Resumen efectivo ──
        lines.push(sep2);
        lines.push(BOLD + 'RESUMEN EFECTIVO' + BOLD_OFF);
        lines.push(sep);
        lines.push(this._lr('Inicial:', `$${fmt(data.efectivo_inicial)}`, W));
        lines.push(this._lr('+ Ventas:', `$${fmt(data.total_efectivo)}`, W));
        lines.push(this._lr('+ Propinas:', `$${fmt(data.propina_efectivo)}`, W));
        lines.push(sep);
        lines.push(BOLD + this._lr('Esperado:', `$${fmt(data.efectivo_esperado)}`, W) + BOLD_OFF);
        lines.push(this._lr('Contado:', `$${fmt(data.efectivo_contado)}`, W));
        const dif = Number(data.diferencia) || 0;
        const difLabel = dif >= 0 ? `+$${fmt(dif)}` : `-$${fmt(Math.abs(dif))}`;
        const difStatus = dif === 0 ? 'OK' : dif > 0 ? '(sobrante)' : '(faltante)';
        lines.push(BOLD + this._lr('DIFERENCIA:', `${difLabel} ${difStatus}`, W) + BOLD_OFF);
        lines.push(sep2);
        lines.push('');

        // ── Resumen de pedidos ──
        lines.push(BOLD + 'RESUMEN DE PEDIDOS' + BOLD_OFF);
        lines.push(sep);
        lines.push(this._lr('Pedidos cobrados:', `${data.num_facturas_cerradas || data.num_facturas || 0}`, W));
        if ((data.num_facturas_anuladas || 0) > 0) {
            lines.push(this._lr('Pedidos anulados:', `${data.num_facturas_anuladas}`, W));
        }
        if ((data.num_notas_credito || 0) > 0) {
            lines.push(this._lr('Notas de ajuste:', `${data.num_notas_credito}`, W));
        }
        if ((data.num_facturas_total || 0) > 0) {
            lines.push(this._lr('Total consecutivos:', `${data.num_facturas_total}`, W));
        }
        if (data.observaciones) {
            lines.push(sep);
            lines.push(`Obs: ${this._sanitize(data.observaciones)}`);
        }
        lines.push(sep2);
        lines.push('');
        lines.push(this._center('** SOLO PARA CONTROL INTERNO **', W));
        lines.push(this._footer());

        return lines.join('\n');
    }

    // ══════════════════════════════════════════════════════
    // PEDIDOS DEL TURNO — Listado detallado de facturas
    // ══════════════════════════════════════════════════════
    formatFacturasTurno(data) {
        const ESC = '\x1B';
        const BOLD = ESC + '\x45\x01';
        const BOLD_OFF = ESC + '\x45\x00';

        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        // ── Header ──
        if (data.tenant_nombre) {
            lines.push(this._center(this._sanitize(data.tenant_nombre.toUpperCase()), W));
        }
        lines.push(sep2);
        lines.push(BOLD + this._center('PEDIDOS DEL TURNO', W) + BOLD_OFF);
        lines.push(sep2);

        // ── Info del turno ──
        lines.push(this._lr('Cajero:', this._sanitize(data.cajero || ''), W));
        lines.push(this._lr('Cierre:', this._fechaHoraSimple(new Date()), W));
        lines.push(sep);

        // ── Resumen contable ──
        const numCerradas = data.num_facturas_cerradas || (data.facturas || []).filter(f => f.tipo === 'cerrada').length;
        const numAnuladas = data.num_facturas_anuladas || (data.facturas || []).filter(f => f.tipo === 'anulada').length;
        const numNA = data.num_notas_credito || (data.facturas || []).filter(f => f.tipo === 'nc').length;
        const numTotal = data.num_facturas_total || (numCerradas + numAnuladas);

        lines.push(this._lr('Pedidos cobrados:', `${numCerradas}`, W));
        if (numAnuladas > 0) lines.push(this._lr('Pedidos anulados:', `${numAnuladas}`, W));
        if (numNA > 0) lines.push(this._lr('Notas de ajuste:', `${numNA}`, W));
        if (numTotal !== numCerradas) lines.push(this._lr('Total consecutivos:', `${numTotal}`, W));
        lines.push(sep);

        // ── Tabla de pedidos ──
        lines.push(BOLD + 'PED       METODO              TOTAL' + BOLD_OFF);
        lines.push(sep);

        for (const f of (data.facturas || [])) {
            const tipo = (f.tipo || 'cerrada').toLowerCase();
            const num = (f.numero_factura || '').padEnd(8, ' ');

            if (tipo === 'anulada') {
                const total = ('$' + fmt(f.total)).padStart(14, ' ');
                lines.push(`${num}  ANULADA          ${total}`);
                if (f.nota_credito && f.nota_credito.numero) {
                    lines.push(`  >> Anulada por ${f.nota_credito.numero}`);
                    if (f.nota_credito.motivo) {
                        lines.push(`     Motivo: ${this._sanitize(f.nota_credito.motivo)}`);
                    }
                } else if (f.motivo_anulacion) {
                    lines.push(`  >> ${this._sanitize(f.motivo_anulacion)}`);
                }
            } else if (tipo === 'nc') {
                const total = ('-$' + fmt(f.total)).padStart(14, ' ');
                lines.push(`[NA]      N/A               ${total}`);
                if (f.nota_credito && f.nota_credito.numero) {
                    lines.push(`  >> ${f.nota_credito.numero}`);
                }
            } else {
                const metodo = this._sanitize((f.metodo_pago || '')).substring(0, 18).padEnd(18, ' ');
                const total = ('$' + fmt(f.total)).padStart(14, ' ');

                lines.push(`${num}  ${metodo}  ${total}`);
                if (f.factura_origen_nc) {
                    lines.push(`  >> Refactura (origen NA)`);
                }

                // Pagos divididos
                if (f.pagos && f.pagos.length > 0) {
                    for (const p of f.pagos) {
                        const propLabel = p.propina > 0 ? ` +serv $${fmt(p.propina)}` : '';
                        lines.push(`          ${p.metodo}: $${fmt(p.monto)}${propLabel}`);
                    }
                }
            }
        }

        // ── Totales ──
        lines.push(sep2);
        lines.push(this._lr('Total ventas:', `$${fmt(data.total_ventas)}`, W));
        lines.push(this._lr('Total servicio:', `$${fmt(data.total_propinas)}`, W));
        const totalIng = (Number(data.total_ventas) || 0) + (Number(data.total_propinas) || 0);
        lines.push(sep);
        lines.push(BOLD + this._lr('TOTAL INGRESO:', `$${fmt(data.total_ingreso || totalIng)}`, W) + BOLD_OFF);
        lines.push(sep2);
        lines.push('');
        lines.push(this._center('** SOLO PARA CONTROL INTERNO **', W));
        lines.push(this._footer());

        return lines.join('\n');
    }

    // ══════════════════════════════════════════════════════
    // VENTAS POR PLU — Productos vendidos en el turno
    // ══════════════════════════════════════════════════════
    formatVentasPLU(data) {
        const ESC = '\x1B';
        const BOLD = ESC + '\x45\x01';
        const BOLD_OFF = ESC + '\x45\x00';

        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        // ── Header ──
        if (data.tenant_nombre) {
            lines.push(this._center(this._sanitize(data.tenant_nombre.toUpperCase()), W));
        }
        lines.push(sep2);
        lines.push(BOLD + this._center('VENTAS POR PRODUCTO', W) + BOLD_OFF);
        lines.push(sep2);

        // ── Info del turno ──
        lines.push(this._lr('Cajero:', this._sanitize(data.cajero || ''), W));
        lines.push(this._lr('Cierre:', this._fechaHoraSimple(new Date()), W));
        lines.push(sep);

        // ── Tabla de productos ──
        lines.push(BOLD + 'PRODUCTO                  CANT    TOTAL' + BOLD_OFF);
        lines.push(sep);

        for (const p of (data.productos || [])) {
            const nombre = this._sanitize((p.nombre || '').substring(0, 24)).padEnd(24, ' ');
            const cant = String(p.cantidad).padStart(4, ' ');
            const total = ('$' + fmt(p.valor)).padStart(10, ' ');
            lines.push(`${nombre} ${cant} ${total}`);
        }

        // ── Totales ──
        lines.push(sep2);
        lines.push(BOLD + this._lr('Total items:', `${data.total_items || 0}`, W) + BOLD_OFF);
        lines.push(BOLD + this._lr('Total valor:', `$${fmt(data.total_valor)}`, W) + BOLD_OFF);
        lines.push(sep2);
        lines.push('');
        lines.push(this._center('** SOLO PARA CONTROL INTERNO **', W));
        lines.push(this._footer());

        return lines.join('\n');
    }

    // ══════════════════════════════════════════════════════
    // REPORTE DE VENTAS — Resumen por periodo
    // ══════════════════════════════════════════════════════
    formatReporteVentas(data) {
        const ESC = '\x1B';
        const BOLD = ESC + '\x45\x01';
        const BOLD_OFF = ESC + '\x45\x00';

        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        // ── Header ──
        if (data.tenant_nombre) {
            lines.push(this._center(this._sanitize(data.tenant_nombre.toUpperCase()), W));
        }
        lines.push(sep2);
        lines.push(BOLD + this._center('REPORTE DE VENTAS', W) + BOLD_OFF);
        lines.push(sep2);

        // ── Info del periodo ──
        lines.push(this._lr('Periodo:', `${this._sanitize(data.desde || '')} a ${this._sanitize(data.hasta || '')}`, W));
        lines.push(this._lr('Generado:', this._fechaHoraSimple(new Date()), W));
        lines.push(sep);

        // ── Resumen KPIs ──
        if (data.resumen) {
            const r = data.resumen;
            lines.push(BOLD + 'RESUMEN' + BOLD_OFF);
            lines.push(sep);
            lines.push(this._lr('  Pedidos:', `${r.total_facturas || 0}`, W));
            lines.push(this._lr('  Venta bruta:', `$${fmt(r.venta_bruta)}`, W));
            if (r.total_descuentos > 0) lines.push(this._lr('  Descuentos:', `-$${fmt(r.total_descuentos)}`, W));
            lines.push(this._lr('  Venta neta:', `$${fmt(r.venta_neta)}`, W));
            if (r.total_propinas > 0) lines.push(this._lr('  Propinas:', `$${fmt(r.total_propinas)}`, W));
            lines.push(this._lr('  Ticket prom:', `$${fmt(r.ticket_promedio)}`, W));
            lines.push(this._lr('  Comensales:', `${r.total_comensales || 0}`, W));
            lines.push('');
        }

        // ── Productos vendidos ──
        if (data.productos && data.productos.length > 0) {
            lines.push(sep2);
            lines.push(BOLD + 'PRODUCTOS VENDIDOS' + BOLD_OFF);
            lines.push(sep);
            lines.push(BOLD + 'CANT  PRODUCTO          INGRESO' + BOLD_OFF);
            lines.push(sep);

            let totalCant = 0;
            let totalIngreso = 0;
            for (const p of data.productos) {
                const cant = String(p.cantidad || 0).padStart(3, ' ');
                const nombre = this._sanitize((p.nombre || '').substring(0, 16)).padEnd(16, ' ');
                const ingreso = ('$' + fmt(p.ingreso_neto)).padStart(12, ' ');
                lines.push(`${cant}   ${nombre} ${ingreso}`);
                totalCant += Number(p.cantidad) || 0;
                totalIngreso += Number(p.ingreso_neto) || 0;
            }
            lines.push(sep);
            lines.push(BOLD + `${String(totalCant).padStart(3, ' ')}   ${'TOTAL'.padEnd(16, ' ')} ${('$' + fmt(totalIngreso)).padStart(12, ' ')}` + BOLD_OFF);
            lines.push('');
        }

        // ── Metodos de pago ──
        if (data.metodos && data.metodos.length > 0) {
            lines.push(sep2);
            lines.push(BOLD + 'METODOS DE PAGO' + BOLD_OFF);
            lines.push(sep);
            for (const m of data.metodos) {
                const metodo = this._sanitize((m.metodo || '').substring(0, 20));
                lines.push(this._lr(`  ${metodo}:`, `$${fmt(m.total)}`, W));
            }
            lines.push('');
        }

        lines.push(sep2);
        lines.push('');
        lines.push(this._center('** SOLO PARA CONTROL INTERNO **', W));
        lines.push(this._footer());

        return lines.join('\n');
    }

    // ── Helpers de formato ──
    _center(text, width = 42) {
        if (text.length >= width) return text;
        const pad = Math.floor((width - text.length) / 2);
        return ' '.repeat(pad) + text;
    }

    _lr(left, right, width = 42) {
        const gap = width - left.length - right.length;
        return left + ' '.repeat(Math.max(gap, 1)) + right;
    }

    _rpad(val, width) {
        const s = String(val);
        return s.length >= width ? s : ' '.repeat(width - s.length) + s;
    }

    // ── Footer + espacio de corte ──
    _footer() {
        const W = 48;
        const lines = [];
        lines.push('');
        lines.push(this._center('Sistema de gestion', W));
        // Espacio amplio para que la impresora térmica
        // avance lo suficiente antes de cortar y no
        // pierda el footer. Equivale a ~5 líneas en blanco.
        lines.push('');
        lines.push('');
        lines.push('');
        lines.push('');
        lines.push('');
        return lines.join('\n');
    }

    // ══════════════════════════════════════════
    // CORRECCION DE PEDIDO — Tirilla de auditoria
    // ══════════════════════════════════════════
    formatCorreccion(data) {
        const ESC = '\x1B';
        const BOLD = ESC + '\x45\x01';
        const BOLD_OFF = ESC + '\x45\x00';

        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');
        const now = new Date();

        // ── Header ──
        lines.push(sep2);
        lines.push(BOLD + this._center('CORRECCION DE PEDIDO', W) + BOLD_OFF);
        lines.push(sep2);

        // ── Info ──
        lines.push(this._lr('Pedido:', data.numero_factura || 'N/A', W));
        if (data.mesa_numero) lines.push(this._lr('Mesa:', String(data.mesa_numero), W));
        if (data.mesero) lines.push(this._lr('Mesero:', this._sanitize(data.mesero), W));
        lines.push(this._lr('Fecha:', this._fechaSimple(now), W));
        lines.push(this._lr('Hora:', this._horaSimple(now), W));
        if (data.corregido_por) lines.push(this._lr('Corregido por:', this._sanitize(data.corregido_por), W));
        lines.push(sep);

        // ── Cambios realizados ──
        lines.push(BOLD + 'CAMBIOS REALIZADOS' + BOLD_OFF);
        lines.push(sep);

        const cambios = data.cambios || [];
        for (const c of cambios) {
            if (c.campo === 'metodo_pago') {
                lines.push(this._lr('  Metodo anterior:', String(c.anterior).toUpperCase(), W));
                lines.push(this._lr('  Metodo nuevo:', String(c.nuevo).toUpperCase(), W));
                lines.push('');
            } else if (c.campo === 'servicio') {
                lines.push(this._lr('  Servicio anterior:', `$${fmt(c.anterior)}`, W));
                lines.push(this._lr('  Servicio nuevo:', `$${fmt(c.nuevo)}`, W));
                lines.push('');
            } else if (c.campo === 'total') {
                lines.push(this._lr('  Total anterior:', `$${fmt(c.anterior)}`, W));
                lines.push(this._lr('  Total nuevo:', `$${fmt(c.nuevo)}`, W));
                lines.push('');
            }
        }

        lines.push(sep);
        lines.push(BOLD + `Motivo: ${this._sanitize(data.motivo || 'No especificado')}` + BOLD_OFF);
        lines.push(sep2);
        lines.push('');
        lines.push(this._center('DOCUMENTO DE AUDITORIA', W));
        lines.push(this._center('Conservar para registros', W));
        lines.push(this._footer());

        return lines.join('\n');
    }

    // ══════════════════════════════════════════
    // NOTA DE AJUSTE — Documento de anulacion
    // ══════════════════════════════════════════
    formatNotaCredito(data) {
        const ESC = '\x1B';
        const BOLD = ESC + '\x45\x01';
        const BOLD_OFF = ESC + '\x45\x00';

        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');
        const now = new Date();

        // ── Header ──
        lines.push(sep2);
        lines.push(BOLD + this._center('*** NOTA DE AJUSTE ***', W) + BOLD_OFF);
        if (data.numero_nota) {
            lines.push(this._center(data.numero_nota, W));
        }
        lines.push(sep2);

        // ── Info ──
        lines.push(this._lr('Tipo:', (data.tipo || 'total').toUpperCase(), W));
        lines.push(this._lr('Pedido anulado:', data.factura_original || '', W));
        if (data.mesa_nombre) lines.push(this._lr('Destino:', data.mesa_nombre, W));
        else if (data.mesa_numero) lines.push(this._lr('Mesa destino:', String(data.mesa_numero), W));
        if (data.mesero) lines.push(this._lr('Mesero:', this._sanitize(data.mesero), W));
        lines.push(this._lr('Fecha:', this._fechaSimple(now), W));
        lines.push(this._lr('Hora:', this._horaSimple(now), W));
        lines.push(sep);

        // ── Items del pedido original ──
        const det = data.detalle || {};
        if (det.items_anulados && det.items_anulados.length > 0) {
            lines.push(BOLD + 'ITEMS DEL PEDIDO ORIGINAL' + BOLD_OFF);
            lines.push(sep);
            for (const item of det.items_anulados) {
                const total = item.cantidad * item.precio_unitario;
                const nombre = this._sanitize((item.plato_nombre || '').substring(0, 28));
                lines.push(BOLD + `${nombre}` + BOLD_OFF);
                lines.push(this._lr(`  ${item.cantidad} x $${fmt(item.precio_unitario)}`, `$${fmt(total)}`, W));
            }
            lines.push(sep);
        }

        // ── Totales ──
        if (det.subtotal_original) lines.push(this._lr('Subtotal original:', `$${fmt(det.subtotal_original)}`, W));
        if (det.servicio_original) lines.push(this._lr('Servicio original:', `$${fmt(det.servicio_original)}`, W));
        lines.push(sep);
        lines.push(BOLD + this._lr('MONTO ANULADO:', `$${fmt(data.monto_anulado)}`, W) + BOLD_OFF);
        lines.push(sep2);
        lines.push('');
        lines.push(BOLD + `Motivo: ${this._sanitize(data.motivo || 'No especificado')}` + BOLD_OFF);
        lines.push(sep2);
        lines.push('');
        lines.push(this._center('DOCUMENTO DE CONTROL', W));
        lines.push(this._center('Nota de Ajuste - Conservar', W));
        lines.push(this._center('para registros internos', W));
        lines.push(this._footer());

        return lines.join('\n');
    }

    // Log interno
    log(message) {
        const entry = { time: new Date().toISOString(), msg: message };
        this.logs.unshift(entry);
        if (this.logs.length > this.maxLogs) this.logs.pop();
        console.log(`[${entry.time.substring(11, 19)}] ${message}`);
    }

    // Estado de todas las impresoras
    getStatus() {
        return {
            printers: this.printers,
            recentLogs: this.logs.slice(0, 30),
        };
    }
}

module.exports = PrinterManager;
