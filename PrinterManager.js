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

    // ══════════════════════════════════════════
    // COMANDA — estilo POS profesional
    // ══════════════════════════════════════════
    formatComanda(payload) {
        // Detectar si es una comanda de anulación
        if (payload.tipo_comanda === 'anulacion') {
            return this.formatComandaAnulacion(payload);
        }

        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const now = new Date();
        const fecha = now.toLocaleDateString('es-CO');
        const hora = payload.hora || now.toLocaleTimeString('es-CO');

        // Header compacto
        lines.push(this._center(`COMANDA #${payload.comanda} | ${(payload.area || '').toUpperCase()}`, W));
        lines.push(sep2);

        // Info mesa
        lines.push(`Mesa: ${payload.mesa}`);
        lines.push(`Mesero: ${payload.mesero}`);
        if (payload.comensales) lines.push(`Personas: ${payload.comensales}`);
        lines.push(`Fecha: ${fecha}   Hora: ${hora}`);
        lines.push(sep);

        // Encabezado tabla
        lines.push('PRODUCTO' + ' '.repeat(W - 8 - 8) + 'CANTIDAD');
        lines.push(sep);

        // Items
        (payload.items || []).forEach(item => {
            const nombre = (item.nombre || item.producto || '').toUpperCase();
            const cant = String(item.cantidad || 1);
            const cantCol = `UND  ${cant.padStart(3, ' ')}`;
            if (nombre.length <= W - cantCol.length - 2) {
                lines.push(nombre.padEnd(W - cantCol.length, ' ') + cantCol);
            } else {
                lines.push(nombre);
                lines.push(' '.repeat(W - cantCol.length) + cantCol);
            }
            if (item.comentario) {
                lines.push(`  >> ${item.comentario}`);
            }
        });

        lines.push(sep2);
        lines.push('');
        lines.push('');
        lines.push('');
        lines.push('');

        return lines.join('\n');
    }

    // ══════════════════════════════════════════
    // ANULACIÓN — formato diferenciado POS
    // ══════════════════════════════════════════
    formatComandaAnulacion(payload) {
        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const sepX = 'X'.repeat(W);
        const now = new Date();
        const fecha = now.toLocaleDateString('es-CO');
        const hora = payload.hora || now.toLocaleTimeString('es-CO');

        // Header prominente de ANULACIÓN
        lines.push(sep2);
        lines.push(this._center('*** ANULACION ***', W));
        lines.push(this._center(`#${payload.comanda} | ${(payload.area || '').toUpperCase()}`, W));
        lines.push(sep2);

        // Info mesa
        lines.push(`Mesa: ${payload.mesa}`);
        lines.push(`Mesero: ${payload.mesero}`);
        lines.push(`Fecha: ${fecha}   Hora: ${hora}`);
        lines.push(sep);

        // Motivo de anulación
        if (payload.motivo) {
            lines.push(this._center('MOTIVO:', W));
            lines.push(this._center(payload.motivo.toUpperCase(), W));
            lines.push(sep);
        }

        // Encabezado tabla
        lines.push(this._center('** ANULAR PLATO **', W));
        lines.push(sep);

        // Items con cantidad NEGATIVA
        (payload.items || []).forEach(item => {
            const nombre = (item.nombre || item.producto || '').toUpperCase();
            const cant = Math.abs(Number(item.cantidad) || 1);
            const cantCol = `UND  -${String(cant).padStart(2, ' ')}`;
            if (nombre.length <= W - cantCol.length - 2) {
                lines.push(nombre.padEnd(W - cantCol.length, ' ') + cantCol);
            } else {
                lines.push(nombre);
                lines.push(' '.repeat(W - cantCol.length) + cantCol);
            }
            // Mostrar comentario/motivo
            if (item.comentario) {
                lines.push(`  >> ${item.comentario}`);
            }
        });

        lines.push(sepX);
        lines.push(this._center('** NO PREPARAR - ANULADO **', W));
        lines.push(sepX);
        lines.push('');
        lines.push('');
        lines.push('');
        lines.push('');

        return lines.join('\n');
    }

    // ══════════════════════════════════════════
    // FACTURA — estilo Doc. Equivalente POS
    // ══════════════════════════════════════════
    formatFactura(factura) {
        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const now = new Date();
        const fecha = now.toLocaleDateString('es-CO');
        const hora = now.toLocaleTimeString('es-CO');
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        // Empresa header
        if (factura.tenant_nombre) {
            lines.push(this._center(factura.tenant_nombre.toUpperCase(), W));
        }
        if (factura.nit) lines.push(this._center(`NIT: ${factura.nit}`, W));
        lines.push(sep);

        // Documento
        lines.push(this._center(factura.numero_factura || 'FACTURA DE VENTA', W));
        lines.push(sep);

        // Info
        lines.push(`Fecha: ${fecha}        Hora: ${hora}`);
        lines.push(`Mesa: ${factura.mesa_numero || ''}`);
        lines.push(`Mesero: ${factura.mesero || ''}`);
        lines.push(`Cliente: ${factura.cliente || 'Consumidor final'}`);
        lines.push(sep);

        // Tabla items
        if (factura.items) {
            //        CANT  PRODUCTO         V.UNI     TOTAL
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

        // Totales
        lines.push(this._lr('SUBTOTAL:', `$${fmt(factura.subtotal)}`, W));
        if (factura.descuento_monto > 0) {
            lines.push(this._lr('DESCUENTO:', `-$${fmt(factura.descuento_monto)}`, W));
        }
        if (factura.monto_servicio > 0) {
            lines.push(this._lr('SERVICIO:', `$${fmt(factura.monto_servicio)}`, W));
        }
        if (factura.monto_iva > 0) {
            lines.push(this._lr('IVA:', `$${fmt(factura.monto_iva)}`, W));
        }
        if (factura.propina > 0) {
            lines.push(this._lr('PROPINA:', `$${fmt(factura.propina)}`, W));
        }
        lines.push(sep2);
        lines.push(this._lr('TOTAL FACTURA:', `$ ${fmt(factura.total)}`, W));
        lines.push(sep2);

        // Forma de pago
        const metodoLabels = {
            efectivo: 'Efectivo', datafono: 'Datafono', tarjeta: 'Tarjeta',
            transferencia: 'Transferencia', credito: 'Credito', nequi: 'Nequi',
        };
        const labelMetodo = (m) => {
            const key = (m || '').toLowerCase();
            // Formato compuesto: 'efectivo+datafono'
            if (key.includes('+')) {
                return key.split('+').map(k => metodoLabels[k] || k).join(' + ');
            }
            return metodoLabels[key] || m || 'Efectivo';
        };

        lines.push(this._center('FORMAS DE PAGO', W));
        lines.push(sep);
        if (factura.pagos && factura.pagos.length > 0) {
            // Desglose por método con sus montos y propinas individuales
            for (const p of factura.pagos) {
                const metodoStr = labelMetodo(p.metodo || p.metodo_pago).padEnd(14, ' ');
                lines.push(this._lr(metodoStr + ':', `$${fmt(p.monto)}`, W));
                if (Number(p.propina) > 0) {
                    lines.push(this._lr('  + Servicio:', `$${fmt(p.propina)}`, W));
                }
            }
        } else if (factura.metodo_pago) {
            // Pago simple o fallback
            const metodoStr = labelMetodo(factura.metodo_pago);
            lines.push(this._lr(metodoStr + ':', `$${fmt(factura.total)}`, W));
        }
        lines.push(sep);
        lines.push('');
        lines.push(this._center('Gracias por su visita!', W));
        lines.push(this._footer());

        return lines.join('\n');
    }

    // ══════════════════════════════════════════
    // PRECUENTA — Verificación de Cuenta
    // ══════════════════════════════════════════
    formatPrecuenta(data) {
        const W = 48;
        const lines = [];
        const sep = '-'.repeat(W);
        const sep2 = '='.repeat(W);
        const now = new Date();
        const fecha = now.toLocaleDateString('es-CO');
        const hora = now.toLocaleTimeString('es-CO');
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        // Header
        lines.push(sep);
        lines.push(this._center('VERIFICACION DE CUENTA', W));
        if (data.tenant_nombre) {
            lines.push(this._center(data.tenant_nombre.toUpperCase(), W));
        }
        lines.push(sep);

        // Info
        lines.push(`Fecha: ${fecha}        Hora: ${hora}`);
        lines.push(`MESA: ${data.mesa_numero || ''}`);
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
        if (data.monto_servicio > 0) {
            lines.push(this._lr('Servicio:', `$${fmt(data.monto_servicio)}`, W));
        }
        if (data.monto_iva > 0) {
            lines.push(this._lr('IVA:', `$${fmt(data.monto_iva)}`, W));
        }


        // Propina sugerida
        const propinaPct = Number(data.porcentaje_propina_sugerida) || 10;
        const propinaMonto = Number(data.propina_sugerida) || Math.round((Number(data.subtotal) || 0) * propinaPct / 100);
        if (propinaMonto > 0) {
            lines.push(this._center(`(${propinaPct}%)`, W));
            lines.push(sep);
            lines.push(this._lr('PROPINA SUGERIDA :', `$ ${fmt(propinaMonto || 0)}`, W));
            lines.push(sep);
            lines.push(this._lr('TOTAL + SERVICIO:', `$ ${fmt((Number(data.total) || 0) + propinaMonto)}`, W));
        }

        lines.push(sep2);
        lines.push('');
        lines.push(this._center('** NO VALIDO COMO FACTURA **', W));
        lines.push(this._center('Documento de verificacion', W));
        lines.push(this._footer());

        return lines.join('\n');
    }

    // Formatear cierre de caja
    formatCierreCaja(data) {
        const lines = [];
        const sep = '='.repeat(48);
        const sep2 = '-'.repeat(48);
        const W = 48;
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        lines.push(sep);
        lines.push('         CIERRE DE CAJA');
        lines.push(sep);
        lines.push(`Cajero: ${data.cajero || ''}`);
        if (data.fecha_apertura) {
            lines.push(`Apertura: ${new Date(data.fecha_apertura).toLocaleString('es-CO')}`);
        }
        lines.push(`Cierre:   ${new Date(data.fecha_cierre || Date.now()).toLocaleString('es-CO')}`);
        lines.push(sep2);

        // Ventas por método de pago
        lines.push('');
        lines.push('VENTAS POR METODO DE PAGO:');
        lines.push(sep2);
        lines.push(this._lr('Efectivo:', `$${fmt(data.total_efectivo)}`, W));
        lines.push(this._lr('Datafono:', `$${fmt(data.total_datafono)}`, W));
        lines.push(this._lr('Transferencia:', `$${fmt(data.total_transferencia)}`, W));
        if (data.total_credito > 0) lines.push(this._lr('Credito:', `$${fmt(data.total_credito)}`, W));
        lines.push(sep2);
        lines.push(this._lr('TOTAL VENTAS:', `$${fmt(data.total_ventas)}`, W));

        // Servicio (propinas + servicio sugerido)
        lines.push('');
        lines.push('SERVICIO:');
        lines.push(sep2);
        if (data.propina_efectivo > 0) lines.push(this._lr('  Efectivo:', `$${fmt(data.propina_efectivo)}`, W));
        if (data.propina_datafono > 0) lines.push(this._lr('  Datafono:', `$${fmt(data.propina_datafono)}`, W));
        if (data.propina_transferencia > 0) lines.push(this._lr('  Transferencia:', `$${fmt(data.propina_transferencia)}`, W));
        lines.push(this._lr('TOTAL SERVICIO:', `$${fmt(data.total_propinas)}`, W));

        // Total ingreso
        lines.push('');
        lines.push(sep);
        const totalIngreso = (Number(data.total_ventas) || 0) + (Number(data.total_propinas) || 0);
        lines.push(this._lr('TOTAL INGRESO:', `$${fmt(data.total_ingreso || totalIngreso)}`, W));
        lines.push(sep);

        // Descuentos y cortesías
        const totalDesc = Number(data.total_descuentos) || 0;
        const totalCort = Number(data.total_cortesias) || 0;
        if (totalDesc > 0 || totalCort > 0) {
            lines.push('');
            lines.push('DESCUENTOS Y CORTESIAS:');
            lines.push(sep2);
            if (data.total_descuentos_mesa > 0) lines.push(this._lr('  Dcto Mesa:', `-$${fmt(data.total_descuentos_mesa)}`, W));
            if (data.total_descuentos_items > 0) lines.push(this._lr('  Dcto Items:', `-$${fmt(data.total_descuentos_items)}`, W));
            if (totalCort > 0) lines.push(this._lr('  Cortesias:', `-$${fmt(totalCort)}`, W));
            lines.push(this._lr('TOTAL DCTOS:', `-$${fmt(totalDesc + totalCort)}`, W));
        }

        // Anulaciones
        if (data.num_anulaciones > 0 || data.items_anulados > 0) {
            lines.push('');
            lines.push('ANULACIONES:');
            lines.push(sep2);
            if (data.num_anulaciones > 0) lines.push(this._lr('  Facturas anuladas:', `${data.num_anulaciones}`, W));
            if (data.monto_anulaciones > 0) lines.push(this._lr('  Monto anulado:', `$${fmt(data.monto_anulaciones)}`, W));
            if (data.items_anulados > 0) lines.push(this._lr('  Items anulados:', `${data.items_anulados}`, W));
        }

        // Factura electrónica
        if (data.num_facturas_electronicas > 0) {
            lines.push('');
            lines.push(this._lr('FACT. ELECTRONICAS:', `${data.num_facturas_electronicas} de ${data.num_facturas}`, W));
            lines.push(this._lr('  Total FE:', `$${fmt(data.total_facturas_electronicas)}`, W));
        }

        // Resumen efectivo
        lines.push('');
        lines.push(sep);
        lines.push('RESUMEN EFECTIVO:');
        lines.push(sep2);
        lines.push(this._lr('Inicial:', `$${fmt(data.efectivo_inicial)}`, W));
        lines.push(this._lr('+ Ventas:', `$${fmt(data.total_efectivo)}`, W));
        lines.push(this._lr('+ Propinas:', `$${fmt(data.propina_efectivo)}`, W));
        lines.push(sep2);
        lines.push(this._lr('Esperado:', `$${fmt(data.efectivo_esperado)}`, W));
        lines.push(this._lr('Contado:', `$${fmt(data.efectivo_contado)}`, W));
        const dif = Number(data.diferencia) || 0;
        const difLabel = dif >= 0 ? `+$${fmt(dif)}` : `-$${fmt(Math.abs(dif))}`;
        lines.push(this._lr('DIFERENCIA:', `${difLabel} ${dif === 0 ? '✓' : dif > 0 ? '(sobrante)' : '(faltante)'}`, W));

        // Footer: desglose de facturas (consistente con tirilla de facturas)
        lines.push('');
        lines.push(sep2);
        lines.push(this._lr('Facturas cobradas:', `${data.num_facturas_cerradas || data.num_facturas || 0}`, W));
        if ((data.num_facturas_anuladas || 0) > 0) {
            lines.push(this._lr('Facturas anuladas:', `${data.num_facturas_anuladas}`, W));
        }
        if ((data.num_notas_credito || 0) > 0) {
            lines.push(this._lr('Notas credito:', `${data.num_notas_credito}`, W));
        }
        if ((data.num_facturas_total || 0) > 0) {
            lines.push(this._lr('Total consecutivos:', `${data.num_facturas_total}`, W));
        }
        if (data.observaciones) {
            lines.push(sep2);
            lines.push(`Obs: ${data.observaciones}`);
        }
        lines.push(sep);
        lines.push(this._footer());

        return lines.join('\n');
    }

    // ══════════════════════════════════════════════════════
    // Tirilla 2: Facturas del turno
    // ══════════════════════════════════════════════════════
    formatFacturasTurno(data) {
        const lines = [];
        const sep = '='.repeat(48);
        const sep2 = '-'.repeat(48);
        const W = 48;
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        lines.push(sep);
        lines.push('      FACTURAS DEL TURNO');
        lines.push(sep);
        lines.push(`Cajero: ${data.cajero || ''}`);
        lines.push(`Cierre: ${new Date().toLocaleString('es-CO')}`);

        // Desglose contable claro (sin ambigüedades)
        const numCerradas = data.num_facturas_cerradas || (data.facturas || []).filter(f => f.tipo === 'cerrada').length;
        const numAnuladas = data.num_facturas_anuladas || (data.facturas || []).filter(f => f.tipo === 'anulada').length;
        const numNC = data.num_notas_credito || (data.facturas || []).filter(f => f.tipo === 'nc').length;
        const numTotal = data.num_facturas_total || (numCerradas + numAnuladas);

        lines.push(`Facturas cobradas:  ${numCerradas}`);
        if (numAnuladas > 0) lines.push(`Facturas anuladas:  ${numAnuladas}`);
        if (numNC > 0)       lines.push(`Notas credito:      ${numNC}`);
        if (numTotal !== numCerradas) lines.push(`Total consecutivos: ${numTotal}`);

        if (data.num_facturas_electronicas > 0) {
            lines.push(`Fact. Electronicas: ${data.num_facturas_electronicas}`);
        }
        lines.push(sep2);

        // Header
        lines.push('#FAC   MESA  METODO     TOTAL    HORA');
        lines.push(sep2);

        for (const f of (data.facturas || [])) {
            const tipo = (f.tipo || 'cerrada').toLowerCase();
            const num = (f.numero_factura || '').padEnd(6, ' ');
            const mesa = String(f.mesa_numero || '-').padEnd(5, ' ');
            const hora = (f.hora || '').padStart(5, ' ');
            const feMarker = f.es_factura_electronica ? ' [FE]' : '';

            if (tipo === 'anulada') {
                // Factura anulada: mostrar claramente [ANULADA] y no el método de pago
                const total = ('$' + fmt(f.total)).padStart(9, ' ');
                lines.push(`${num} ${mesa} ANULADA    ${total} ${hora}`);
                // Indicar la NC que la anuló
                if (f.nota_credito && f.nota_credito.numero) {
                    lines.push(`  >> Anulada por ${f.nota_credito.numero}`);
                    if (f.nota_credito.motivo) {
                        lines.push(`     Motivo: ${f.nota_credito.motivo}`);
                    }
                } else if (f.motivo_anulacion) {
                    lines.push(`  >> ${f.motivo_anulacion}`);
                }
            } else if (tipo === 'nc') {
                // Nota Crédito: línea diferenciada
                const total = ('-$' + fmt(f.total)).padStart(9, ' ');
                lines.push(`[NC]   ${mesa}            ${total} ${hora}`);
                if (f.nota_credito && f.nota_credito.numero) {
                    lines.push(`  >> ${f.nota_credito.numero}`);
                }
            } else {
                // Factura cerrada (normal o refactura)
                const metodo = (f.metodo_pago || '').substring(0, 10).padEnd(10, ' ');
                const total = ('$' + fmt(f.total)).padStart(9, ' ');

                if (f.factura_origen_nc) {
                    // Es una refactura creada por NC
                    lines.push(`${num} ${mesa} ${metodo} ${total} ${hora}${feMarker}`);
                    lines.push(`  >> Refactura (origen NC)`);
                } else {
                    lines.push(`${num} ${mesa} ${metodo} ${total} ${hora}${feMarker}`);
                }

                // Pagos divididos
                if (f.pagos && f.pagos.length > 0) {
                    for (const p of f.pagos) {
                        const propLabel = p.propina > 0 ? ` +prop $${fmt(p.propina)}` : '';
                        lines.push(`       ${p.metodo}: $${fmt(p.monto)}${propLabel}`);
                    }
                }
            }
        }

        // Totales
        lines.push(sep);
        lines.push(this._lr('Total ventas:', `$${fmt(data.total_ventas)}`, W));
        lines.push(this._lr('Total servicio:', `$${fmt(data.total_propinas)}`, W));
        const totalIng = (Number(data.total_ventas) || 0) + (Number(data.total_propinas) || 0);
        lines.push(this._lr('TOTAL INGRESO:', `$${fmt(data.total_ingreso || totalIng)}`, W));
        if (data.num_facturas_electronicas > 0) {
            lines.push(sep2);
            lines.push(this._lr('Total Fact. Elect.:', `$${fmt(data.total_facturas_electronicas)}`, W));
        }
        lines.push(sep);
        lines.push(this._footer());

        return lines.join('\n');
    }

    // ══════════════════════════════════════════════════════
    // Tirilla 3: Ventas por PLU (productos vendidos)
    // ══════════════════════════════════════════════════════
    formatVentasPLU(data) {
        const lines = [];
        const sep = '='.repeat(48);
        const sep2 = '-'.repeat(48);
        const W = 48;
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        lines.push(sep);
        lines.push('       VENTAS POR PLU');
        lines.push(sep);
        lines.push(`Cajero: ${data.cajero || ''}`);
        lines.push(`Cierre: ${new Date().toLocaleString('es-CO')}`);
        lines.push(sep2);

        // Header
        lines.push('PRODUCTO                  CANT    TOTAL');
        lines.push(sep2);

        for (const p of (data.productos || [])) {
            const nombre = (p.nombre || '').substring(0, 24).padEnd(24, ' ');
            const cant = String(p.cantidad).padStart(4, ' ');
            const total = ('$' + fmt(p.valor)).padStart(10, ' ');
            lines.push(`${nombre} ${cant} ${total}`);
        }

        // Totales
        lines.push(sep);
        lines.push(this._lr('Total items:', `${data.total_items || 0}`, W));
        lines.push(this._lr('Total valor:', `$${fmt(data.total_valor)}`, W));
        lines.push(sep);
        lines.push(this._footer());

        return lines.join('\n');
    }

    // Formatear reporte de ventas de productos
    formatReporteVentas(data) {
        const lines = [];
        const sep = '='.repeat(48);
        const sep2 = '-'.repeat(48);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        lines.push(sep);
        lines.push('       REPORTE DE VENTAS');
        lines.push(sep);
        lines.push(`Periodo: ${data.desde || ''} a ${data.hasta || ''}`);
        lines.push(`Generado: ${new Date().toLocaleString('es-CO')}`);
        lines.push(sep2);

        // Resumen KPIs
        if (data.resumen) {
            const r = data.resumen;
            lines.push('');
            lines.push('RESUMEN:');
            lines.push(sep2);
            lines.push(`  Facturas:     ${r.total_facturas || 0}`);
            lines.push(`  Venta bruta:  $${fmt(r.venta_bruta)}`);
            if (r.total_descuentos > 0) lines.push(`  Descuentos:  -$${fmt(r.total_descuentos)}`);
            lines.push(`  Venta neta:   $${fmt(r.venta_neta)}`);
            if (r.total_propinas > 0) lines.push(`  Propinas:     $${fmt(r.total_propinas)}`);
            lines.push(`  Ticket prom:  $${fmt(r.ticket_promedio)}`);
            lines.push(`  Comensales:   ${r.total_comensales || 0}`);
        }

        // Productos vendidos
        if (data.productos && data.productos.length > 0) {
            lines.push('');
            lines.push(sep);
            lines.push('PRODUCTOS VENDIDOS:');
            lines.push(sep2);
            lines.push('Cant  Producto          Ingreso');
            lines.push(sep2);

            let totalCant = 0;
            let totalIngreso = 0;
            for (const p of data.productos) {
                const cant = String(p.cantidad || 0).padStart(3, ' ');
                const nombre = (p.nombre || '').substring(0, 16).padEnd(16, ' ');
                const ingreso = (p.ingreso_neto || 0).toLocaleString('es-CO');
                lines.push(`${cant}  ${nombre}  $${ingreso}`);
                totalCant += Number(p.cantidad) || 0;
                totalIngreso += Number(p.ingreso_neto) || 0;
            }
            lines.push(sep2);
            lines.push(`${String(totalCant).padStart(3, ' ')}  ${'TOTAL'.padEnd(16, ' ')}  $${fmt(totalIngreso)}`);
        }

        // Métodos de pago
        if (data.metodos && data.metodos.length > 0) {
            lines.push('');
            lines.push(sep2);
            lines.push('METODOS DE PAGO:');
            lines.push(sep2);
            for (const m of data.metodos) {
                const metodo = (m.metodo || '').substring(0, 16).padEnd(16, ' ');
                lines.push(`  ${metodo} $${fmt(m.total)}`);
            }
        }

        lines.push(sep);
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
        lines.push(this._center('- - -  Foodly  - - -', W));
        lines.push(this._center('Carlos Olaya Dev', W));
        lines.push(this._center('www.foodly.com', W));
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
    // CORRECCIÓN ADMINISTRATIVA — tirilla auditoría
    // ══════════════════════════════════════════
    formatCorreccion(data) {
        const W = 48;
        const lines = [];
        const sep = '='.repeat(W);
        const sep2 = '-'.repeat(W);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');
        const now = new Date();

        lines.push(sep);
        lines.push(this._center('*** CORRECCION DE FACTURA ***', W));
        lines.push(sep);
        lines.push('');
        lines.push(this._lr('Factura:', data.numero_factura || 'N/A', W));
        if (data.mesa_numero) lines.push(this._lr('Mesa:', String(data.mesa_numero), W));
        if (data.mesero) lines.push(this._lr('Mesero:', data.mesero, W));
        lines.push(this._lr('Fecha:', now.toLocaleDateString('es-CO'), W));
        lines.push(this._lr('Hora:', now.toLocaleTimeString('es-CO'), W));
        if (data.corregido_por) lines.push(this._lr('Corregido por:', data.corregido_por, W));
        lines.push(sep2);
        lines.push('');
        lines.push('CAMBIOS REALIZADOS:');
        lines.push(sep2);

        const cambios = data.cambios || [];
        for (const c of cambios) {
            if (c.campo === 'metodo_pago') {
                lines.push(this._lr('Metodo anterior:', String(c.anterior).toUpperCase(), W));
                lines.push(this._lr('Metodo nuevo:', String(c.nuevo).toUpperCase(), W));
                lines.push('');
            } else if (c.campo === 'servicio') {
                lines.push(this._lr('Servicio anterior:', `$${fmt(c.anterior)}`, W));
                lines.push(this._lr('Servicio nuevo:', `$${fmt(c.nuevo)}`, W));
                lines.push('');
            } else if (c.campo === 'total') {
                lines.push(this._lr('Total anterior:', `$${fmt(c.anterior)}`, W));
                lines.push(this._lr('Total nuevo:', `$${fmt(c.nuevo)}`, W));
                lines.push('');
            }
        }

        lines.push(sep2);
        lines.push(`Motivo: ${data.motivo || 'No especificado'}`);
        lines.push(sep2);
        lines.push('');
        lines.push(this._center('DOCUMENTO DE AUDITORIA', W));
        lines.push(this._center('Conservar para registros', W));
        lines.push(this._footer());

        return lines.join('\n');
    }

    // ══════════════════════════════════════════
    // NOTA CRÉDITO — documento fiscal de anulación
    // ══════════════════════════════════════════
    formatNotaCredito(data) {
        const W = 48;
        const lines = [];
        const sep = '='.repeat(W);
        const sep2 = '-'.repeat(W);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');
        const now = new Date();

        lines.push(sep);
        lines.push(this._center('*** NOTA CREDITO ***', W));
        lines.push(this._center(data.numero_nota || '', W));
        lines.push(sep);
        lines.push('');
        lines.push(this._lr('Tipo:', (data.tipo || 'total').toUpperCase(), W));
        lines.push(this._lr('Factura anulada:', data.factura_original || '', W));
        if (data.mesa_numero) lines.push(this._lr('Mesa destino:', String(data.mesa_numero), W));
        if (data.mesero) lines.push(this._lr('Mesero:', data.mesero, W));
        lines.push(this._lr('Fecha:', now.toLocaleDateString('es-CO'), W));
        lines.push(this._lr('Hora:', now.toLocaleTimeString('es-CO'), W));
        lines.push(sep2);

        // Detalle de lo anulado
        const det = data.detalle || {};
        if (det.items_anulados && det.items_anulados.length > 0) {
            lines.push('');
            lines.push('ITEMS DE LA FACTURA ORIGINAL:');
            lines.push(sep2);
            for (const item of det.items_anulados) {
                const total = item.cantidad * item.precio_unitario;
                const nombre = (item.plato_nombre || '').substring(0, 28);
                lines.push(`${nombre}`);
                lines.push(this._lr(`  ${item.cantidad} x $${fmt(item.precio_unitario)}`, `$${fmt(total)}`, W));
            }
            lines.push(sep2);
        }

        lines.push('');
        if (det.subtotal_original) lines.push(this._lr('Subtotal original:', `$${fmt(det.subtotal_original)}`, W));
        if (det.servicio_original) lines.push(this._lr('Servicio original:', `$${fmt(det.servicio_original)}`, W));
        lines.push(sep2);
        lines.push(this._lr('MONTO ANULADO:', `$${fmt(data.monto_anulado)}`, W));
        lines.push(sep2);
        lines.push('');
        lines.push(`Motivo: ${data.motivo || 'No especificado'}`);
        lines.push(sep2);
        lines.push('');
        lines.push(this._center('DOCUMENTO FISCAL', W));
        lines.push(this._center('Nota Credito - Conservar', W));
        lines.push(this._center('para registros contables', W));
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
